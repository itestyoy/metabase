import { useState } from "react";
import { t } from "ttag";

import { Button, Flex, Select, Stack, Text, TextInput, Title } from "metabase/ui";

import type { AgentSettings } from "./types";

const MODEL_OPTIONS = [
  { value: "gpt-4o", label: "GPT-4o (recommended)" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini (faster)" },
  { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
];

interface AgentSettingsFormProps {
  settings: AgentSettings;
  onSave: (settings: AgentSettings) => void;
  onBack: () => void;
}

export function AgentSettingsForm({
  settings,
  onSave,
  onBack,
}: AgentSettingsFormProps) {
  const [apiKey, setApiKey] = useState(settings.openaiApiKey);
  const [model, setModel] = useState(settings.model || "gpt-4o");

  const handleSave = () => {
    onSave({ openaiApiKey: apiKey.trim(), model });
    onBack();
  };

  return (
    <Stack p="md" gap="md" style={{ flex: 1, overflowY: "auto" }}>
      <Title order={5}>{t`AI Agent Settings`}</Title>

      <TextInput
        label={t`OpenAI API Key`}
        type="password"
        placeholder="sk-..."
        value={apiKey}
        onChange={e => setApiKey(e.target.value)}
        description={t`Stored only in your browser's localStorage. Never sent to Metabase servers.`}
      />

      <Select
        label={t`Model`}
        data={MODEL_OPTIONS}
        value={model}
        onChange={val => setModel(val ?? "gpt-4o")}
      />

      <Flex gap="sm" justify="flex-end" mt="auto">
        <Button variant="subtle" onClick={onBack}>
          {t`Cancel`}
        </Button>
        <Button variant="filled" onClick={handleSave} disabled={!apiKey.trim()}>
          {t`Save`}
        </Button>
      </Flex>
    </Stack>
  );
}
