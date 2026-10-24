import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { DemoGrid, DemoState } from "../_shared/DemoState";
import { ComboBox, ComboBoxItem, type ComboBoxItemProps } from "./ComboBox";

interface Place {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly kind: string;
}

const places: readonly Place[] = [
  { id: "den", name: "Denver", region: "Colorado, United States", kind: "City" },
  { id: "dal", name: "Dallas", region: "Texas, United States", kind: "City" },
  { id: "dul", name: "Duluth", region: "Minnesota, United States", kind: "City" },
];

function renderPlace(place: Place): ReactElement<ComboBoxItemProps> {
  return (
    <ComboBoxItem
      id={place.id}
      textValue={place.name}
      title={place.name}
      subtitle={place.region}
      meta={place.kind}
    />
  );
}

/** Kitchen-sink states of {@link ComboBox}. Popover states open as soon as the field is used. */
function ComboBoxDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Default">
        <ComboBox<Place> label="Origin" placeholder="City or address" items={[]}>
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Recent places (opens on focus)">
        <ComboBox<Place> label="Origin" items={places} recentItems={places.slice(0, 2)}>
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Too short (type one letter)">
        <ComboBox<Place> label="Origin" items={places} defaultInputValue="D">
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Loading (keeps previous results)">
        <ComboBox<Place> label="Origin" items={places} status="loading" defaultInputValue="Den">
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Results">
        <ComboBox<Place> label="Origin" items={places} defaultInputValue="D">
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Empty">
        <ComboBox<Place> label="Origin" items={[]} defaultInputValue="Zzzz">
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Error">
        <ComboBox<Place> label="Origin" items={[]} status="error" defaultInputValue="Den">
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Selected">
        <ComboBox<Place>
          label="Origin"
          items={places}
          defaultValue="den"
          defaultInputValue="Denver"
        >
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Invalid">
        <ComboBox<Place>
          label="Destination"
          items={places}
          isInvalid
          errorMessage="Choose a place from the list."
        >
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Disabled">
        <ComboBox<Place> label="Origin" items={places} defaultInputValue="Denver" isDisabled>
          {renderPlace}
        </ComboBox>
      </DemoState>
      <DemoState title="Read only">
        <ComboBox<Place> label="Origin" items={places} defaultInputValue="Denver" isReadOnly>
          {renderPlace}
        </ComboBox>
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for ComboBox: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "ComboBox",
  description: "Searchable place picker with recent searches and loading, empty and error states.",
  states: [{ id: "states", title: "States", node: <ComboBoxDemo /> }],
};
