import { useState } from "react";

import {
  Button,
  Flex,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "metabase/ui";

import type { AgentSettings } from "./types";

const MODEL_OPTIONS = [
  { value: "gpt-4o", label: "GPT-4o (recommended)" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini (faster, cheaper)" },
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
    <Stack p="md" gap="md">
      <Title order={5}>Agent Settings</Title>

      <Stack gap="xs">
        <Text size="sm" fw={500}>
          OpenAI API Key
        </Text>
        <TextInput
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          description="Your key is stored only in browser localStorage and never sent to Metabase servers."
        />
      </Stack>

      <Stack gap="xs">
        <Text size="sm" fw={500}>
          Model
        </Text>
        <Select
          data={MODEL_OPTIONS}
          value={model}
          onChange={val => setModel(val ?? "gpt-4o")}
        />
      </Stack>

      <Flex gap="sm" justify="flex-end">
        <Button variant="subtle" onClick={onBack}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!apiKey.trim()}>
          Save
        </Button>
      </Flex>
    </Stack>
  );
}
