import type { ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { Tab, TabList, TabPanel, Tabs, type TabsProps } from "./Tabs";

function RouteTabs(props: Omit<TabsProps, "children">): ReactElement {
  return (
    <Tabs {...props}>
      <TabList aria-label="Route details">
        <Tab id="checkpoints">{copy.tabs.checkpoints}</Tab>
        <Tab id="profile">{copy.tabs.profile}</Tab>
        <Tab id="details">{copy.tabs.details}</Tab>
      </TabList>
      <TabPanel id="checkpoints">The checkpoint table sits here.</TabPanel>
      <TabPanel id="profile">The risk profile chart sits here.</TabPanel>
      <TabPanel id="details">The trip facts sit here.</TabPanel>
    </Tabs>
  );
}

/** Kitchen-sink states of {@link Tabs}. */
export default function TabsDemo(): ReactElement {
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
