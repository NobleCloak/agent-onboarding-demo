import { describe, expect, it } from "vitest";
import { GET } from "../app/favicon.ico/route";

describe("/favicon.ico", () => {
  it("redirects to the app icon, on whatever host it was asked", () => {
    const res = GET(new Request("http://127.0.0.1:3417/favicon.ico"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:3417/icon.svg");
  });
});
