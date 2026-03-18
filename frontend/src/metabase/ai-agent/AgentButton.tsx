import { t } from "ttag";

import { ActionIcon, Flex, Icon, Text, Tooltip } from "metabase/ui";

import { AgentModal } from "./AgentModal";
import S from "./AgentButton.module.css";
import { useAgentAccess } from "./hooks/useAgentAccess";
import { useAgentModal } from "./hooks/useAgentModal";

export function AgentButton() {
  const { hasAccess, isLoading } = useAgentAccess();
  const { isOpen, open, close } = useAgentModal();

  if (isLoading || !hasAccess) {
    return null;
  }

  const label = t`BI Agent`;

  return (
    <>
      <Tooltip label={label}>
        <ActionIcon
          variant="subtle"
          c="text-primary"
          bd="1px solid var(--mb-color-border)"
          p="sm"
          h="2.25rem"
          w="auto"
          aria-label={label}
          onClick={isOpen ? close : open}
          className={`${S.aiButton} ${isOpen ? S.aiButtonActive : ""}`}
        >
          <Flex align="center" gap={6}>
            <Icon name="ai" className={isOpen ? S.aiIconActive : S.aiIcon} />
            <Text size="xs" fw={600} lh={1}>{t`BI Agent`}</Text>
          </Flex>
        </ActionIcon>
      </Tooltip>

      {isOpen && <AgentModal onClose={close} />}
    </>
  );
}
