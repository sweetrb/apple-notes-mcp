import { describe, it, expect, vi } from "vitest";
vi.mock("@/utils/checklistParser.js", () => ({ hasFullDiskAccess: vi.fn(() => true) }));
import { runDoctor, formatDoctorReport } from "../tools/doctor.js";
import { hasFullDiskAccess } from "../utils/checklistParser.js";
function fakeMgr(over = {}) {
    return {
        healthCheck: () => ({
            healthy: true,
            checks: [{ name: "reachable", passed: true, message: "Notes.app responded" }],
        }),
        listAccounts: () => [{ name: "iCloud" }, { name: "Gmail" }],
        ...over,
    };
}
describe("runDoctor (#22)", () => {
    it("reports accounts + Full Disk Access and stays healthy on warnings", () => {
        const r = runDoctor(fakeMgr());
        expect(r.healthy).toBe(true);
        expect(r.checks.find((c) => c.name === "Accounts")?.status).toBe("ok");
        expect(r.checks.find((c) => c.name === "Accounts")?.detail).toMatch(/iCloud, Gmail/);
        expect(r.checks.find((c) => c.name === "Full Disk Access")?.status).toBe("ok");
    });
    it("warns (not fails) when Full Disk Access is not granted", () => {
        vi.mocked(hasFullDiskAccess).mockReturnValueOnce(false);
        const r = runDoctor(fakeMgr());
        const fda = r.checks.find((c) => c.name === "Full Disk Access");
        expect(fda?.status).toBe("warn");
        expect(fda?.detail).toMatch(/Full Disk Access/);
        expect(r.healthy).toBe(true);
    });
    it("is unhealthy when a Notes.app check fails", () => {
        const r = runDoctor(fakeMgr({
            healthCheck: () => ({
                healthy: false,
                checks: [{ name: "permission", passed: false, message: "not authorized" }],
            }),
        }));
        expect(r.healthy).toBe(false);
        expect(formatDoctorReport(r)).toMatch(/ISSUES FOUND/);
        expect(formatDoctorReport(r)).toMatch(/❌ Notes\.app: permission/);
    });
});
