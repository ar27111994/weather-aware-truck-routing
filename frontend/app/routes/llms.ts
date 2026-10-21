import { llmsTxt } from "../features/seo/files";
import { SITE_URL } from "../shell/page-meta";

/** `/llms.txt`, written out at build time (a prerendered resource route). */
export function loader(): Response {
  return new Response(llmsTxt(SITE_URL), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
