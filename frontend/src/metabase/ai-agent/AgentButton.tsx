import { t } from "ttag";

import { ActionIcon, Icon, Tooltip } from "metabase/ui";

import { AgentModal } from "./AgentModal";
import S from "./AgentButton.module.css";
import { useAgentAccess } from "./hooks/useAgentAccess";
import { useAgentModal } from "./hooks/useAgentModal";

export function AgentButton() {
  const { hasAccess, isLoading } = useAgentAccess();
  const { isOpen, open, close } = useAgentModal();
  const label = t`AI Agent`;

  if (isLoading || !hasAccess) {
    return null;
  }

  return (
    <>
      <Tooltip label={label}>
        <ActionIcon
          variant="subtle"
          bd="1px solid var(--mb-color-border)"
          h="2.25rem"
          w="2.25rem"
          aria-label={label}
          onClick={open}
          className={S.aiButton}
        >
          <Icon name="ai" className={S.aiIcon} />
        </ActionIcon>
      </Tooltip>

      {isOpen && <AgentModal onClose={close} />}
    </>
  );
}
