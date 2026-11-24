import { expect, test } from "@playwright/test";

const NAV_LABELS = [
  "Home",
  "Inbox",
  "Directory",
  "Onboarding",
  "Time off",
  "Vendors",
  "Purchasing",
  "IT requests",
  "Agents",
  "Tools",
  "Permissions",
];

test("every nav item loads a page with no console errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const label of NAV_LABELS) {
    await nav.getByRole("link", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  expect(problems).toEqual([]);
});

test("the sidebar shows the Onboarding count of 3 and IT requests count of 12", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /^Onboarding/ })).toContainText("3");
  await expect(nav.getByRole("link", { name: /^IT requests/ })).toContainText("12");
});
