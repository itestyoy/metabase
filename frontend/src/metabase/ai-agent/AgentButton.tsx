import { t } from "ttag";

import { ActionIcon, Icon, Tooltip } from "metabase/ui";

import { AgentModal } from "./AgentModal";
import { useAgentModal } from "./hooks/useAgentModal";

export function AgentButton() {
  const { isOpen, open, close } = useAgentModal();
  const label = t`AI Agent`;

  return (
    <>
      <Tooltip label={label}>
        <ActionIcon
          variant="subtle"
          c="var(--mb-color-text-primary)"
          bd="1px solid var(--mb-color-border)"
          h="2.25rem"
          w="2.25rem"
          aria-label={label}
          onClick={open}
        >
          <Icon name="ai" />
        </ActionIcon>
      </Tooltip>

      {isOpen && <AgentModal onClose={close} />}
    </>
  );
}
