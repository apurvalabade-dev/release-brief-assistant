import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { BriefPanel } from "./components/BriefPanel";
import { ComparePanel } from "./components/ComparePanel";
import { PackageEditor } from "./components/PackageEditor";
import { ReleaseList } from "./components/ReleaseList";
import { ReleaseView } from "./components/ReleaseView";
import { ReviewPanel } from "./components/ReviewPanel";
import { samplePackage } from "./sample";
import type { Checks, Review, Statement } from "./types";

afterEach(() => vi.restoreAllMocks());

const ready: Checks = { ready: true, findings: [] };
const blocked: Checks = { ready: false, findings: [{ code: "NO_QA_EVIDENCE", severity: "error", section: "qaSummary", message: "QA summary is empty." }] };
const stmt = (o: Partial<Statement> & { id: number }): Statement => ({
  audience: "internal", section: "change", position: o.id, text: `Statement ${o.id}`, citations: ["F-1"], sourceHash: "h",
  status: "draft", editedByHuman: false, freshness: "fresh", ...o,
});
const review = (statements: Statement[]): Review => ({
  analysis: { model: "mock", createdAt: "2026-10-11T10:00:00Z", classifications: [{ itemId: "F-1", impact: "user_visible", rationale: "Visible." }], gaps: [], unsupportedClaims: [{ itemId: "F-2", reason: "No QA.", evidenceIds: [], source: "deterministic" }] },
  checks: ready, statements,
});

describe("ReleaseList", () => {
  it("lists releases and creates one", async () => {
    vi.spyOn(api, "listReleases").mockResolvedValue([{ id: 1, name: "Acme 2.4", createdAt: "2026-10-11T10:00:00Z", latestVersion: 2 }]);
    const create = vi.spyOn(api, "createRelease").mockResolvedValue({ release: { id: 7, name: "New" }, version: {} as never, checks: ready });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ReleaseList onOpen={onOpen} />);
    expect(await screen.findByText("Acme 2.4")).toBeInTheDocument();
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create release" })).toBeDisabled();
    await user.type(screen.getByLabelText("Release name"), "New");
    await user.click(screen.getByLabelText(/sample package/));
    await user.click(screen.getByRole("button", { name: "Create release" }));
    expect(create).toHaveBeenCalledWith("New", expect.objectContaining({ completedFeatures: expect.arrayContaining([expect.objectContaining({ id: "F-1" })]) }));
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it("shows a readable error when the server is unreachable", async () => {
    vi.spyOn(api, "listReleases").mockRejectedValue(new ApiError(0, { message: "Cannot reach the server." }));
    render(<ReleaseList onOpen={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the server.");
  });
});

describe("PackageEditor", () => {
  it("keeps Save disabled until something changes, then saves with stable ids", async () => {
    const onSave = vi.fn().mockResolvedValue({ created: true });
    const user = userEvent.setup();
    render(<PackageEditor pkg={samplePackage()} onSave={onSave} />);
    const save = screen.getByRole("button", { name: "Save as new version" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add feature" }));
    await user.type(screen.getByLabelText("feature F-3 title"), "Webhooks");
    expect(save).toBeEnabled();
    await user.click(save);
    const saved = onSave.mock.calls[0]![0];
    expect(saved.completedFeatures.map((f: { id: string }) => f.id)).toEqual(["F-1", "F-2", "F-3"]);
    expect(saved.completedFeatures[2].title).toBe("Webhooks");
    expect(await screen.findByRole("status")).toHaveTextContent("Saved as a new version");
  });

  it("removing an item also removes it from QA coverage", async () => {
    const onSave = vi.fn().mockResolvedValue({ created: true });
    const user = userEvent.setup();
    render(<PackageEditor pkg={samplePackage()} onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Remove F-1" }));
    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    const saved = onSave.mock.calls[0]![0];
    expect(saved.completedFeatures.map((f: { id: string }) => f.id)).toEqual(["F-2"]);
    expect(saved.qaSummary.find((q: { id: string }) => q.id === "Q-1").covers).toEqual([]);
  });

  it("toggles QA coverage and adds user groups", async () => {
    const onSave = vi.fn().mockResolvedValue({ created: false });
    const user = userEvent.setup();
    render(<PackageEditor pkg={samplePackage()} onSave={onSave} />);
    await user.click(screen.getByLabelText("Q-1 covers F-2"));
    await user.type(screen.getByLabelText("New user group"), "Support{Enter}");
    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    const saved = onSave.mock.calls[0]![0];
    expect(saved.qaSummary[0].covers).toEqual(["F-1", "F-2"]);
    expect(saved.affectedUserGroups).toEqual(["Admins", "All end users", "Support"]);
    expect(await screen.findByRole("status")).toHaveTextContent("No changes");
  });

  it("shows server validation problems under the Save button", async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError(400, { error: "validation_failed", issues: [{ path: ["completedFeatures", 2, "title"], message: "must not be empty" }] }));
    const user = userEvent.setup();
    render(<PackageEditor pkg={samplePackage()} onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Add feature" }));
    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Some fields are invalid.");
    expect(alert).toHaveTextContent("completedFeatures.2.title: must not be empty");
  });
});

describe("ReviewPanel", () => {
  it("explains why generation is blocked and disables the button", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(null);
    render(<ReviewPanel releaseId={1} versionNo={1} pkg={samplePackage()} checks={blocked} />);
    expect(await screen.findByText("QA summary is empty.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate summaries" })).toBeDisabled();
  });

  it("generates drafts when ready and shows the analysis", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(null);
    const gen = vi.spyOn(api, "generate").mockResolvedValue(review([stmt({ id: 1 })]));
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={1} pkg={samplePackage()} checks={ready} />);
    await user.click(await screen.findByRole("button", { name: "Generate summaries" }));
    expect(gen).toHaveBeenCalledWith(1, 1, false);
    expect(await screen.findByText("Statement 1")).toBeInTheDocument();
    expect(screen.getByText("found by checks")).toBeInTheDocument();
    expect(screen.getByLabelText("AI analysis")).toHaveTextContent("mock");
  });

  it("approves a statement via the API and updates its badge", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1 })]));
    const patch = vi.spyOn(api, "patchStatement").mockResolvedValue(stmt({ id: 1, status: "approved" }));
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={2} pkg={samplePackage()} checks={ready} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(patch).toHaveBeenCalledWith(1, 2, 1, { status: "approved" });
    await waitFor(() => expect(screen.getByText(/1 approved · 0 draft/)).toBeInTheDocument());
  });

  it("blocks approving a stale statement and offers edit or reject", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1, freshness: "stale" })]));
    render(<ReviewPanel releaseId={1} versionNo={2} pkg={samplePackage()} checks={ready} />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText(/sources changed/)).toBeInTheDocument();
    expect(screen.getAllByText("stale").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it("edits statement text and saves it", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1 })]));
    const patch = vi.spyOn(api, "patchStatement").mockResolvedValue(stmt({ id: 1, text: "Better wording", editedByHuman: true }));
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={1} pkg={samplePackage()} checks={ready} />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Statement text");
    await user.clear(box);
    await user.type(box, "Better wording");
    await user.click(screen.getByRole("button", { name: "Save text" }));
    expect(patch).toHaveBeenCalledWith(1, 1, 1, { text: "Better wording" });
    expect(await screen.findByText("Better wording")).toBeInTheDocument();
    expect(screen.getByText("edited")).toBeInTheDocument();
  });

  it("separates audiences and labels each citation with what it points at", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1 }), stmt({ id: 2, audience: "stakeholder", text: "Plain words" })]));
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={1} pkg={samplePackage()} checks={ready} />);
    expect(await screen.findByText("Statement 1")).toBeInTheDocument();
    expect(screen.queryByText("Plain words")).not.toBeInTheDocument();
    expect(screen.getByText("F-1", { selector: ".chip" })).toHaveAttribute("title", expect.stringContaining("CSV export for invoices"));
    await user.click(screen.getByRole("tab", { name: /Stakeholders/ }));
    expect(screen.getByText("Plain words")).toBeInTheDocument();
  });

  it("shows carry-over results", async () => {
    vi.spyOn(api, "getReview").mockResolvedValue(null);
    vi.spyOn(api, "carryOver").mockResolvedValue({ summary: { fromVersion: 1, carried: 3, fresh: 2, stale: 1, sourceRemoved: 0 }, review: review([stmt({ id: 1, freshness: "stale" })]) });
    const user = userEvent.setup();
    render(<ReviewPanel releaseId={1} versionNo={2} pkg={samplePackage()} checks={ready} />);
    await user.click(await screen.findByRole("button", { name: /Carry over statements from v1/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("2 still valid, 1 stale");
  });
});

describe("BriefPanel", () => {
  it("lists what is still pending when the brief is refused", async () => {
    vi.spyOn(api, "listBriefs").mockResolvedValue([]);
    vi.spyOn(api, "makeBrief").mockRejectedValue(new ApiError(409, { error: "review_incomplete", problems: ["2 statements are still in draft", "F-2 has no approved risk statement"] }));
    const user = userEvent.setup();
    render(<BriefPanel releaseId={1} versionNo={1} />);
    await user.click(screen.getByRole("button", { name: "Generate final brief" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The review is not complete yet.");
    expect(within(alert).getByText("2 statements are still in draft")).toBeInTheDocument();
  });

  it("shows the finished brief with the not-an-approval notice", async () => {
    vi.spyOn(api, "listBriefs").mockResolvedValue([]);
    const make = vi.spyOn(api, "makeBrief").mockResolvedValue({ id: 1, audience: "stakeholder", content: "# Release brief\n- New: Dark mode", createdAt: "2026-10-11T10:00:00Z" });
    const user = userEvent.setup();
    render(<BriefPanel releaseId={1} versionNo={3} />);
    expect(screen.getByText(/not a deployment approval/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate final brief" }));
    expect(make).toHaveBeenCalledWith(1, 3, "stakeholder");
    expect(await screen.findByText(/New: Dark mode/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download .md" })).toBeInTheDocument();
  });
});

describe("ComparePanel", () => {
  it("summarizes changes and lists statements that became stale", async () => {
    vi.spyOn(api, "diff").mockResolvedValue({
      sections: [{ section: "completedFeatures", added: [{ id: "F-3" }], removed: [], changed: [{ id: "F-1", label: "CSV export", changes: [{ field: "description", from: "10k rows", to: "50k rows" }] }] }],
      userGroups: { added: ["Support"], removed: [] }, flags: [], hasChanges: true, summary: { added: 2, removed: 0, changed: 1 },
    });
    vi.spyOn(api, "getReview").mockResolvedValue(review([stmt({ id: 1, freshness: "stale", text: "CSV export handles 10k rows" }), stmt({ id: 2 })]));
    render(<ComparePanel releaseId={1} versions={[1, 2]} selected={2} />);
    expect(await screen.findByText("Changes v1 → v2")).toBeInTheDocument();
    expect(screen.getByText("2 added")).toBeInTheDocument();
    expect(screen.getByText("10k rows")).toBeInTheDocument();
    const stale = screen.getByLabelText("Stale statements");
    expect(stale).toHaveTextContent("CSV export handles 10k rows");
    expect(stale).not.toHaveTextContent("Statement 2");
  });

  it("explains how to see stale statements when the newer version has none yet", async () => {
    vi.spyOn(api, "diff").mockResolvedValue({ sections: [], userGroups: { added: [], removed: [] }, flags: [], hasChanges: false, summary: { added: 0, removed: 0, changed: 0 } });
    vi.spyOn(api, "getReview").mockResolvedValue(null);
    render(<ComparePanel releaseId={1} versions={[1, 2]} selected={2} />);
    expect(await screen.findByText("The packages are identical.")).toBeInTheDocument();
    expect(screen.getByText(/carry them over/)).toBeInTheDocument();
  });

  it("asks for two versions when only one exists", () => {
    render(<ComparePanel releaseId={1} versions={[1]} selected={1} />);
    expect(screen.getByText(/at least two versions/)).toBeInTheDocument();
  });
});

describe("ReleaseView", () => {
  it("loads the latest version, and switching tabs loads the review", async () => {
    vi.spyOn(api, "getRelease").mockResolvedValue({ id: 1, name: "Acme 2.4", createdAt: "2026-10-11T10:00:00Z", versions: [{ versionNo: 1, packageHash: "a", createdAt: "2026-10-11T10:00:00Z" }, { versionNo: 2, packageHash: "b", createdAt: "2026-10-11T11:00:00Z" }] });
    const getVersion = vi.spyOn(api, "getVersion").mockResolvedValue({ version: { releaseId: 1, versionNo: 2, package: samplePackage(), packageHash: "b", createdAt: "2026-10-11T11:00:00Z" }, checks: ready });
    const getReview = vi.spyOn(api, "getReview").mockResolvedValue(null);
    const user = userEvent.setup();
    render(<ReleaseView releaseId={1} onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Acme 2.4" })).toBeInTheDocument();
    await waitFor(() => expect(getVersion).toHaveBeenCalledWith(1, 2));
    expect(await screen.findByLabelText("feature F-1 title")).toHaveValue("CSV export for invoices");
    expect(getReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "2. Review" }));
    await waitFor(() => expect(getReview).toHaveBeenCalledWith(1, 2));
  });

  it("shows an error instead of hanging when the release does not exist", async () => {
    vi.spyOn(api, "getRelease").mockRejectedValue(new ApiError(404, { error: "not_found" }));
    render(<ReleaseView releaseId={99} onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
