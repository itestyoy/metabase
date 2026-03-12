import { useState } from "react";

import { Button } from "metabase/ui";

import { AgentModal } from "./AgentModal";

export function AgentButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        h="36px"
        variant="subtle"
        color="text-medium"
        leftSection={<span style={{ fontSize: 16 }}>🤖</span>}
        onClick={() => setIsOpen(true)}
        aria-label="AI Agent"
        style={{ fontWeight: 600 }}
      >
        Agent
      </Button>

      {isOpen && <AgentModal onClose={() => setIsOpen(false)} />}
    </>
  );
}
