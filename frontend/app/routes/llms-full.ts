import { llmsFullTxt } from "../features/seo/files";
import { SITE_URL } from "../shell/page-meta";

/** `/llms-full.txt`, written out at build time (a prerendered resource route). */
export function loader(): Response {
  return new Response(llmsFullTxt(SITE_URL), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
