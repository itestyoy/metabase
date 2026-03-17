import { t } from "ttag";

import { ActionIcon, Icon, Tooltip } from "metabase/ui";

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
          w="2.25rem"
          aria-label={label}
          onClick={isOpen ? close : open}
          className={`${S.aiButton} ${isOpen ? S.aiButtonActive : ""}`}
        >
          <Icon name="ai" className={isOpen ? S.aiIconActive : S.aiIcon} />
        </ActionIcon>
      </Tooltip>

      {isOpen && <AgentModal onClose={close} />}
    </>
  );
}
