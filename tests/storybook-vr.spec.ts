import {readFileSync} from "node:fs";
import {expect, test} from "@playwright/test";

// One screenshot test per story in the BUILT Storybook. The story list
// comes from storybook-static/index.json read synchronously at spec
// load (Playwright requires tests to be declared synchronously) — the
// build always precedes the run via the test:vr npm scripts.
interface IndexEntry {
    id: string;
    type: string;
}

const index = JSON.parse(
    readFileSync(new URL("../storybook-static/index.json", import.meta.url), "utf8"),
) as {entries: Record<string, IndexEntry>};

const storyIds = Object.values(index.entries)
    .filter((e) => e.type === "story")
    .map((e) => e.id);

for (const id of storyIds) {
    test(id, async ({page}) => {
        await page.goto(`/iframe.html?id=${id}&viewMode=story`);
        // sb-show-main appears when the story has rendered (works for
        // stories that legitimately render nothing); errordisplay means
        // the story threw — fail rather than baseline an error screen.
        await page.waitForSelector("body.sb-show-main", {timeout: 15_000});
        await expect(page.locator("body")).not.toHaveClass(/sb-show-errordisplay/);
        await page.evaluate(() => document.fonts.ready);
        // Small settle for play functions (rename focus, panel open).
        await page.waitForTimeout(400);
        await expect(page).toHaveScreenshot(`${id}.png`);
    });
}
