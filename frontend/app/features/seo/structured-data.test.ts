import { describe, expect, it } from "vitest";

import { faqPageLd, techArticleLd, webApplicationLd } from "./structured-data";

const ORIGIN = "https://haulcast.example";

describe("webApplicationLd", () => {
  it("describes the planner as a free web application", () => {
    expect(webApplicationLd(ORIGIN)).toMatchInlineSnapshot(`
      {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "applicationCategory": "TravelApplication",
        "browserRequirements": "Requires JavaScript",
        "description": "Compare three truck routes by forecast weather risk at the truck's own arrival time, with a 48-hour corridor forecast.",
        "featureList": [
          "Compares up to three truck routes between two places",
          "Scores wind, rain and snow risk at checkpoints every 10, 25 or 50 miles",
          "Raises wind risk for heavy loads with published load rules",
          "Shows a 48-hour weather forecast map along the route corridor",
        ],
        "inLanguage": "en-US",
        "isAccessibleForFree": true,
        "name": "Haulcast",
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD",
        },
        "operatingSystem": "Any",
        "url": "https://haulcast.example/",
      }
    `);
  });

  it("names no address when the build does not know the address of the site", () => {
    expect(webApplicationLd(undefined)).not.toHaveProperty("url");
  });
});

describe("techArticleLd", () => {
  it("describes the methodology page as a technical article", () => {
    expect(techArticleLd(ORIGIN)).toMatchInlineSnapshot(`
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        "about": "Weather risk scoring and route ranking for truck routes",
        "description": "Every checkpoint is scored with the weather forecast for the hour the truck is expected to be there, using the assessment's risk and load rules.",
        "headline": "How Haulcast scores weather risk",
        "inLanguage": "en-US",
        "isAccessibleForFree": true,
        "mainEntityOfPage": "https://haulcast.example/methodology",
        "publisher": {
          "@type": "Organization",
          "name": "Haulcast",
        },
        "url": "https://haulcast.example/methodology",
      }
    `);
  });

  it("names no address when the build does not know the address of the site", () => {
    const article = techArticleLd(undefined);

    expect(article).not.toHaveProperty("url");
    expect(article).not.toHaveProperty("mainEntityOfPage");
  });
});

describe("faqPageLd", () => {
  it("is the questions of the page and their answers, word for word", () => {
    const faq = faqPageLd();

    expect(faq["@type"]).toBe("FAQPage");
    const entities = faq["mainEntity"] as readonly {
      name: string;
      acceptedAnswer: { text: string };
    }[];
    expect(entities.map((entity) => entity.name)).toEqual([
      "How does Haulcast choose the recommended route?",
      "What do the risk levels mean?",
      "Why does the weight of my load change the risk?",
      "Which weather does each checkpoint use?",
      "Does Haulcast include rest breaks or live traffic?",
    ]);
    expect(entities[4]?.acceptedAnswer.text).toBe(
      "No. Arrival times assume the truck drives without stopping, and live traffic and road closures are not used.",
    );
  });
});
