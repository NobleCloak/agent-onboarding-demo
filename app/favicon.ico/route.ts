// Browsers that ask for /favicon.ico anyway (Safari, some tab previews) get the app icon instead of a 404.
export const GET = (request: Request) => Response.redirect(new URL("/icon.svg", request.url), 308);
