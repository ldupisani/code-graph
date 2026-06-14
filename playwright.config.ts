import {defineConfig} from "@playwright/test";

// Visual-regression config: screenshots every built Storybook story.
// Run via `npm run test:vr` (builds storybook-static first) or
// `npm run test:vr:update` to regenerate baselines.
//
// Baselines under tests/__screenshots__/ are rendered on macOS system
// fonts — when CI lands, regenerate a linux set inside the Playwright
// container (the snapshot name template below is platform-agnostic on
// purpose, so a CI baseline refresh replaces rather than forks them).
export default defineConfig({
    testDir: "tests",
    fullyParallel: true,
    reporter: [["list"]],
    snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
    expect: {
        toHaveScreenshot: {
            animations: "disabled",
            maxDiffPixelRatio: 0.01,
        },
    },
    use: {
        baseURL: "http://127.0.0.1:6006",
        viewport: {width: 1000, height: 700},
        deviceScaleFactor: 1,
    },
    webServer: {
        command: "npx http-server storybook-static -p 6006 -s",
        url: "http://127.0.0.1:6006/index.json",
        reuseExistingServer: true,
        timeout: 30_000,
    },
});
