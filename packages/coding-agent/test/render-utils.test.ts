import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it } from "vitest";
import { linkPath } from "../src/core/tools/render-utils.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-render-path-"));
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
});
afterEach(async () => {
	resetCapabilitiesCache();
	await rm(root, { recursive: true, force: true });
});

it("links to the native tool target without changing styled display text", async () => {
	await mkdir(join(root, "actual/nested"), { recursive: true });
	await symlink(join(root, "actual/nested"), join(root, "link"), "junction");
	await writeFile(join(root, "file"), "LEXICAL");
	await writeFile(join(root, "actual/file"), "PHYSICAL");
	const addressed = `${root}/link/../file`;
	const text = "\x1b[31mlink/../file\x1b[39m";
	const rendered = linkPath(text, "link/../file", root);
	const url = rendered.match(/\x1b\]8;;([^\x1b]+)\x1b\\/)?.[1];
	expect(url).toBeDefined();
	expect(await readFile(fileURLToPath(url!), "utf8")).toBe(await readFile(addressed, "utf8"));
	expect(url).toBe(pathToFileURL(await realpath(addressed)).href);
	expect(rendered).toContain(text);
});

it("retains exact Unicode and @-prefixed tool addressing in the link", async () => {
	const filename = "space\u00a0name";
	await writeFile(join(root, filename), "EXACT");
	await writeFile(join(root, "space name"), "NEIGHBOR");
	const url = pathToFileURL(await realpath(join(root, filename))).href;
	expect(linkPath("display", `@${filename}`, root)).toContain(url);
});

it("keeps representable new-file links and omits links whose traversal cannot be represented", () => {
	expect(linkPath("new", "new", root)).toContain(pathToFileURL(join(root, "new")).href);
	if (process.platform !== "win32") {
		expect(linkPath("missing/../new", "missing/../new", root)).toBe("missing/../new");
	}
});

it.skipIf(process.platform === "win32")(
	"does not link an invalid native directory traversal to a regular file",
	async () => {
		await writeFile(join(root, "file"), "ORIGINAL");
		expect(linkPath("file/", "file/", root)).toBe("file/");
		expect(linkPath("file/../file", "file/../file", root)).toBe("file/../file");
	},
);

it("leaves display text unchanged when terminal hyperlinks are disabled", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	expect(linkPath("styled text", "file", root)).toBe("styled text");
});
