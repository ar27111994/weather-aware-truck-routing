import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { Tab, TabList, TabPanel, Tabs, type TabsProps } from "./Tabs";

function RouteTabs(props: Omit<TabsProps, "children">): ReactElement {
  return (
    <Tabs {...props}>
      <TabList aria-label="Route details">
        <Tab id="checkpoints">{t("tabs.checkpoints")}</Tab>
        <Tab id="profile">{t("tabs.profile")}</Tab>
        <Tab id="details">{t("tabs.details")}</Tab>
      </TabList>
      <TabPanel id="checkpoints">The checkpoint table sits here.</TabPanel>
      <TabPanel id="profile">The risk profile chart sits here.</TabPanel>
      <TabPanel id="details">The trip facts sit here.</TabPanel>
    </Tabs>
  );
}

/** Kitchen-sink states of {@link Tabs}. */
function TabsDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="First tab selected">
        <RouteTabs />
      </DemoState>
      <DemoState title="Another tab selected">
        <RouteTabs defaultSelectedKey="profile" />
      </DemoState>
      <DemoState title="Disabled tab">
        <RouteTabs disabledKeys={["profile"]} defaultSelectedKey="details" />
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for Tabs: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "Tabs",
  description: "Text tabs with an ink underline and automatic keyboard activation.",
  states: [{ id: "states", title: "States", node: <TabsDemo /> }],
};
