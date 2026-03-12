import type { MouseEvent } from "react";
import { useState } from "react";
import { t } from "ttag";

import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import { ActionIcon, Box, Icon, Text, UnstyledButton } from "metabase/ui";

import S from "./AgentContextPicker.module.css";

/** What the AI agent receives as context for the current conversation. */
export interface AgentContextValue {
  id: number;
  name: string;
  /** "card" | "dataset" | "metric" | "table" | "dashboard" */
  model: string;
  db_id?: number;
  /** Query-string parameters from the current URL, if any. */
  url_params?: Record<string, string>;
}

interface AgentContextPickerProps {
  value: AgentContextValue | null;
  onChange: (value: AgentContextValue | null) => void;
}

const ICON: Record<string, string> = {
  card: "question",
  dataset: "model",
  metric: "metric",
  table: "database",
  dashboard: "dashboard",
};

const LABEL: () => Record<string, string> = () => ({
  card: t`Question`,
  dataset: t`Model`,
  metric: t`Metric`,
  table: t`Table`,
  dashboard: t`Dashboard`,
});

export function AgentContextPicker({ value, onChange }: AgentContextPickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleChange = (item: MiniPickerPickableItem) => {
    onChange({
      id: item.id as number,
      name: item.name,
      model: item.model,
      db_id: item.model === "table" ? (item as { db_id?: number }).db_id : undefined,
    });
    setIsOpen(false);
  };

  const handleClear = (e: MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  return (
    <Box className={S.contextBar}>
      <Icon name="layers" size={12} className={S.contextIcon} />
      <Text size="xs" c="text-light" className={S.contextLabel}>
        {t`Context:`}
      </Text>

      {/*
        Anchor wrapper: MiniPicker renders a Mantine Menu internally.
        Its Menu.Target is an invisible <Box />, so the dropdown
        positions itself relative to this container element.
      */}
      <Box className={S.contextAnchor}>
        {value ? (
          <UnstyledButton
            className={S.contextChip}
            onClick={() => setIsOpen((o: boolean) => !o)}
          >
            <Icon name={ICON[value.model] ?? "database"} size={11} />
            <Text size="xs" className={S.contextChipText} title={value.name}>
              {LABEL()[value.model] ?? value.model}: {value.name}
            </Text>
            <ActionIcon
              size={14}
              variant="transparent"
              className={S.contextChipClear}
              onClick={handleClear}
              aria-label={t`Remove context`}
            >
              <Icon name="close" size={9} />
            </ActionIcon>
          </UnstyledButton>
        ) : (
          <UnstyledButton
            className={S.contextEmpty}
            onClick={() => setIsOpen((o: boolean) => !o)}
          >
            <Icon name="add" size={10} className={S.contextAddIcon} />
            <Text size="xs" c="text-light">{t`Add context`}</Text>
          </UnstyledButton>
        )}

        <MiniPicker
          opened={isOpen}
          onClose={() => setIsOpen(false)}
          onChange={handleChange}
          models={["card", "dataset", "metric", "table"]}
          dropdownMt={4}
        />
      </Box>
    </Box>
  );
}
