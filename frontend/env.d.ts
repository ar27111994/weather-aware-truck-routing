/**
 * Build-time variables the app reads from `import.meta.env`. Vite types every key as `any`, so each
 * variable the code touches is declared here and read without a cast.
 */
interface ImportMetaEnv {
  /**
   * Origin of the deployed site, such as `https://haulcast.example`. Canonical and Open Graph URLs
   * are absolute and need it; without it they are left out.
   */
  readonly VITE_SITE_URL?: string;
}
