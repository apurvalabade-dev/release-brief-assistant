import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { ReviewPanel } from "./components/ReviewPanel";
import { samplePackage } from "./sample";
import type { Review, Statement } from "./types";

afterEach(() => vi.restoreAllMocks());

const stmt = (o: Partial<Statement> & { id: number }): Statement => ({
  audience: "internal", section: "change", position: o.id, text: `Statement ${o.id}`, citations: ["F-1"], sourceHash: "h",
  status: "approved", editedByHuman: false, freshness: "fresh", ...o,
});
const review = (statements: Statement[]): Review => ({ analysis: null, checks: { ready: true, findings: [] }, statements });
const ready = { ready: true, findings: [] };

describe("adding a statement for an uncovered item", () => {
  it("lists items that no statement covers, prefilled so one click starts the statement", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1 })]));
    const add = vi.spyOn(api, "addStatement").mockResolvedValue(stmt({ id: 9, text: "Dark mode is new.", citations: ["F-2"], status: "draft", editedByHuman: true }));
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={2} pkg={samplePackage()} checks={ready} />);

    const coverage = await screen.findByLabelText("Add a statement");
    expect(coverage).toHaveTextContent("Not covered yet");
    expect(screen.queryByRole("button", { name: "Write statement for F-1" })).not.toBeInTheDocument(); // F-1 is cited
    await user.click(screen.getByRole("button", { name: "Write statement for F-2" }));
    expect(screen.getByLabelText("Cite F-2")).toBeChecked();
    expect(screen.getByRole("button", { name: "Add statement" })).toBeDisabled(); // no text yet

    await user.type(screen.getByLabelText("New statement text"), "Dark mode is new.");
    await user.click(screen.getByRole("button", { name: "Add statement" }));
    expect(add).toHaveBeenCalledWith(1, 2, { audience: "internal", section: "change", text: "Dark mode is new.", citations: ["F-2"] });
    await waitFor(() => expect(screen.queryByLabelText("New statement text")).not.toBeInTheDocument()); // form closed
    const listed = await screen.findByText("Dark mode is new.");
    expect(listed.closest("li.statement")).not.toBeNull(); // shown as a statement, not just echoed in the textarea
    await waitFor(() => expect(screen.queryByRole("button", { name: "Write statement for F-2" })).not.toBeInTheDocument());
  });

  it("requires at least one source and shows server errors", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1 })]));
    vi.spyOn(api, "addStatement").mockRejectedValue(new ApiError(400, { error: "unknown_citation", ids: ["X-9"] }));
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={1} pkg={samplePackage()} checks={ready} />);
    await user.click(await screen.findByRole("button", { name: "Add a statement" }));
    await user.type(screen.getByLabelText("New statement text"), "Some text");
    expect(screen.getByRole("button", { name: "Add statement" })).toBeDisabled(); // text but no source
    await user.click(screen.getByLabelText("Cite F-1"));
    await user.click(screen.getByRole("button", { name: "Add statement" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("New statement text")).toHaveValue("Some text"); // nothing lost on error
  });

  it("does not offer anything to write once every change item is covered", async () => {
    const all = samplePackage();
    const ids = [...all.completedFeatures, ...all.bugFixes, ...all.changedBehaviour].map((i) => i.id);
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1, citations: ids })]));
    render(<ReviewPanel releaseId={1} versionNo={1} pkg={all} checks={ready} />);
    await screen.findByLabelText("Add a statement");
    expect(screen.queryByText(/Not covered yet/)).not.toBeInTheDocument();
  });
});
