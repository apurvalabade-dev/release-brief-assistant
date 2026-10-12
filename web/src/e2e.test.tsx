/**
 * End-to-end: the real React app in jsdom talking to a REAL running server (mock LLM) and Postgres.
 * Skipped unless E2E_API_URL is set:  E2E_API_URL=http://localhost:3001 npm test -w web
 * Creates data in whatever database that server uses, so point it at a throwaway one.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const base = process.env["E2E_API_URL"];

describe.skipIf(!base)("full workflow against the real server", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => realFetch(String(input).startsWith("/") ? `${base}${input}` : input, init));
  });
  afterAll(() => vi.unstubAllGlobals());

  async function approveAll() {
    // Approve every enabled "Approve" button, for both audiences.
    for (const tabName of [/Internal/, /Stakeholders/]) {
      await userEvent.click(screen.getByRole("tab", { name: tabName }));
      for (let guard = 0; guard < 40; guard++) {
        const btn = screen.queryAllByRole("button", { name: "Approve" }).find((b) => !(b as HTMLButtonElement).disabled);
        if (!btn) break;
        await userEvent.click(btn);
        await waitFor(() => {});
      }
    }
  }

  it("create → generate → approve → brief → edit → carry over → stale", { timeout: 60_000 }, async () => {
    const user = userEvent.setup();
    window.location.hash = "";
    render(<App />);

    // Create a release from the sample package
    await user.type(await screen.findByLabelText("Release name"), "E2E release");
    await user.click(screen.getByLabelText(/sample package/));
    await user.click(screen.getByRole("button", { name: "Create release" }));
    expect(await screen.findByRole("heading", { name: "E2E release" })).toBeInTheDocument();
    expect(await screen.findByLabelText("feature F-1 title")).toHaveValue("CSV export for invoices");

    // Review: generate drafts
    await user.click(screen.getByRole("tab", { name: "2. Review" }));
    await user.click(await screen.findByRole("button", { name: "Generate summaries" }));
    expect(await screen.findByLabelText("AI analysis")).toHaveTextContent("mock");
    expect(screen.getByLabelText("AI analysis")).toHaveTextContent("found by checks");
    expect(await screen.findAllByRole("button", { name: "Approve" })).not.toHaveLength(0);

    // The brief is refused while statements are still drafts, with the reasons listed
    await user.click(screen.getByRole("tab", { name: "3. Final brief" }));
    await user.click(screen.getByRole("button", { name: "Generate final brief" }));
    const refused = await screen.findByRole("alert");
    expect(refused).toHaveTextContent(/not complete/i);
    expect(within(refused).getAllByRole("listitem").length).toBeGreaterThan(0);

    // Approve everything, then the brief is produced
    await user.click(screen.getByRole("tab", { name: "2. Review" }));
    await approveAll();
    await user.click(screen.getByRole("tab", { name: "3. Final brief" }));
    await user.click(screen.getByRole("button", { name: "Generate final brief" }));
    const brief = await screen.findByLabelText("Final brief");
    expect(brief).toHaveTextContent("Dark mode");
    expect(brief).toHaveTextContent(/not .*approval/i);

    // Edit a cited feature → saves as version 2
    await user.click(screen.getByRole("tab", { name: "1. Package" }));
    const desc = screen.getByLabelText("feature F-1 description");
    await user.clear(desc);
    await user.type(desc, "Admins can export up to 50,000 invoices.");
    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved as a new version");
    await waitFor(() => expect(screen.getByLabelText("Version")).toHaveValue("2"));

    // Carry statements over: the ones about F-1 are stale
    await user.click(screen.getByRole("tab", { name: "2. Review" }));
    await user.click(await screen.findByRole("button", { name: /Carry over statements from v1/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(/stale/);
    expect(screen.getAllByText("stale").length).toBeGreaterThan(0);
    const staleApprove = screen.getAllByRole("button", { name: "Approve" }).filter((b) => (b as HTMLButtonElement).disabled);
    expect(staleApprove.length).toBeGreaterThan(0);

    // Compare tab shows the field-level change and lists the stale statements
    await user.click(screen.getByRole("tab", { name: "Compare versions" }));
    expect(await screen.findByText("Changes v1 → v2")).toBeInTheDocument();
    expect(screen.getByText("50,000", { exact: false })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Stale statements")).getAllByRole("listitem").length).toBeGreaterThan(0);

    // The brief for v2 is refused while stale statements are pending
    await user.click(screen.getByRole("tab", { name: "3. Final brief" }));
    await user.click(screen.getByRole("button", { name: "Generate final brief" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
