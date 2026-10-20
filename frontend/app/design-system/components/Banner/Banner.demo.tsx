import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { Button } from "../Button";
import { Banner } from "./Banner";

export const demo: Demo = {
  name: "Banner",
  description:
    "Notices on the panel. Errors and the do-not-depart result interrupt; the rest wait their turn. Scenario banners are hatched and dashed so simulated weather is never mistaken for a forecast.",
  states: [
    {
      id: "info",
      title: "Info",
      node: (
        <Banner variant="info" title={t("banner.fewerRoutes.title")}>
          The router found two routes for this trip.
        </Banner>
      ),
    },
    {
      id: "warning",
      title: "Warning: partial weather",
      node: (
        <Banner variant="warning" title={t("banner.partialWeather.title")}>
          {t("banner.partialWeather.body", { count: 3 })}
        </Banner>
      ),
    },
    {
      id: "danger",
      title: "Danger: an error",
      node: (
        <Banner variant="danger" title={t("error.routing_unavailable.title")}>
          {t("error.routing_unavailable.body")}
        </Banner>
      ),
    },
    {
      id: "scenario",
      title: "Scenario: simulated weather",
      node: (
        <Banner variant="scenario" title={t("banner.scenario.title")}>
          {t("banner.scenario.body", { name: "Blizzard on I-80" })}
        </Banner>
      ),
    },
    {
      id: "no-safe-route",
      title: "No safe route, with a paper action",
      node: (
        <Banner
          variant="no-safe-route"
          title={t("banner.noSafeRoute.title")}
          action={<Button variant="secondary">{t("banner.noSafeRoute.action")}</Button>}
        >
          {t("banner.noSafeRoute.body", { route: "B", miles: "14.2" })}
        </Banner>
      ),
    },
  ],
};
