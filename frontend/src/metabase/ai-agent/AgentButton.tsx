import { t } from "ttag";

import { Button, Icon } from "metabase/ui";

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

  return (
    <>
      <Button
        variant="subtle"
        h="2.25rem"
        px="sm"
        leftSection={<Icon name="ai" size={16} className={S.aiIcon} />}
        aria-label={t`BI Agent`}
        onClick={open}
        className={`${S.aiButton} ${isOpen ? S.aiButtonActive : ""}`}
      >
        <span className={S.aiButtonLabel}>{t`BI Agent`}</span>
      </Button>

      {isOpen && <AgentModal onClose={close} />}
    </>
  );
}
