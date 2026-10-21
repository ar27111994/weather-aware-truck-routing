import { t } from "../../design-system/foundation/strings";
import type { RiskRules } from "../../api/contract";
import { RISK_RULES } from "../../lib/risk";
import { FAQ_IDS, faqAnswer, faqQuestion } from "../methodology/rules-text";

/** A JSON-LD object (schema.org): inert data in a `<script type="application/ld+json">`, never run. */
export type JsonLd = Readonly<Record<string, unknown>>;

const CONTEXT = "https://schema.org";

/** The address of a page on the site, or `undefined` when the build has no site origin. */
function addressOf(origin: string | undefined, path: string): string | undefined {
  return origin === undefined ? undefined : new URL(path, origin).href;
}

/** `{ url: … }` when there is an address, else nothing: no URL is guessed. */
function withUrl(key: string, address: string | undefined): Record<string, string> {
  return address === undefined ? {} : { [key]: address };
}

/**
 * The planner as schema.org describes an app (R12): what it is, what it costs, what it does and
 * what it needs. No rating, review or price claim beyond the fact that it is free.
 */
export function webApplicationLd(origin: string | undefined): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "WebApplication",
    name: t("app.name"),
    description: t("app.description"),
    applicationCategory: "TravelApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript",
    inLanguage: "en-US",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    featureList: [
      t("seo.features.routes"),
      t("seo.features.risk"),
      t("seo.features.load"),
      t("seo.features.forecast"),
    ],
    ...withUrl("url", addressOf(origin, "/")),
  };
}

/** The methodology page as a technical article about the scoring rules. */
export function techArticleLd(origin: string | undefined): JsonLd {
  const address = addressOf(origin, "/methodology");
  return {
    "@context": CONTEXT,
    "@type": "TechArticle",
    headline: t("methodology.title"),
    description: t("methodology.lead"),
    about: t("seo.methodologyAbout"),
    inLanguage: "en-US",
    isAccessibleForFree: true,
    publisher: { "@type": "Organization", name: t("app.name") },
    ...withUrl("url", address),
    ...(address === undefined ? {} : { mainEntityOfPage: address }),
  };
}

/** The questions the methodology page answers, word for word as the page shows them. */
export function faqPageLd(rules: RiskRules = RISK_RULES): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: FAQ_IDS.map((id) => ({
      "@type": "Question",
      name: faqQuestion(id),
      acceptedAnswer: { "@type": "Answer", text: faqAnswer(id, rules) },
    })),
  };
}
