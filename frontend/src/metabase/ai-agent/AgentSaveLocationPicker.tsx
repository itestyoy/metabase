import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "ttag";

import api from "metabase/lib/api";
import { ActionIcon, Box, Icon, Menu, Text, UnstyledButton } from "metabase/ui";

import S from "./AgentSaveLocationPicker.module.css";

export interface SaveLocation {
  id: number;
  name: string;
}

interface AgentSaveLocationPickerProps {
  value: SaveLocation | null;
  onChange: (value: SaveLocation | null) => void;
}

interface CollectionTreeNode {
  id: number;
  name: string;
  personal_owner_id?: number | null;
  children?: CollectionTreeNode[];
}

/** Breadcrumb entry for the drill-down navigation stack. */
interface NavEntry {
  id: number;
  name: string;
}

export function AgentSaveLocationPicker({ value, onChange }: AgentSaveLocationPickerProps) {
  const [tree, setTree] = useState<CollectionTreeNode[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  /** Navigation stack — empty means we're at root level. */
  const [navStack, setNavStack] = useState<NavEntry[]>([]);

  // Fetch full collection tree when dropdown opens for the first time
  useEffect(() => {
    if (!isOpen || tree.length > 0) {
      return;
    }
    setIsLoading(true);
    api
      .GET("/api/collection/tree")({})
      .then((data: unknown) => {
        const nodes = data as CollectionTreeNode[];
        setTree(nodes.filter(n => n.id > 0)); // exclude root
      })
      .catch(() => setTree([]))
      .finally(() => setIsLoading(false));
  }, [isOpen, tree.length]);

  // Reset navigation when dropdown closes
  useEffect(() => {
    if (!isOpen) {
      setNavStack([]);
    }
  }, [isOpen]);

  /** Find the children to display at the current navigation depth. */
  const currentItems = useMemo(() => {
    if (navStack.length === 0) {
      return tree;
    }
    // Walk the tree following the nav stack
    let nodes = tree;
    for (const entry of navStack) {
      const found = nodes.find(n => n.id === entry.id);
      if (!found?.children) {
        return [];
      }
      nodes = found.children;
    }
    return nodes;
  }, [tree, navStack]);

  const handleDrillIn = useCallback((node: CollectionTreeNode) => {
    setNavStack(prev => [...prev, { id: node.id, name: node.name }]);
  }, []);

  const handleGoBack = useCallback(() => {
    setNavStack(prev => prev.slice(0, -1));
  }, []);

  const handleSelect = useCallback(
    (node: CollectionTreeNode) => {
      onChange({ id: node.id, name: node.name });
      setIsOpen(false);
    },
    [onChange],
  );

  const handleClear = (e: MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  /** The collection we're currently browsing inside (last in nav stack). */
  const currentParent = navStack.length > 0 ? navStack[navStack.length - 1] : null;

  return (
    <Box className={S.saveBar}>
      <Text size="xs" c="text-tertiary" className={S.saveLabel}>
        {t`Save to:`}
      </Text>

      <Menu
        opened={isOpen}
        onClose={() => setIsOpen(false)}
        closeOnItemClick={false}
        position="bottom-start"
        shadow="md"
        width={260}
      >
        <Menu.Target>
          {value ? (
            <UnstyledButton
              className={S.saveChip}
              onClick={() => setIsOpen(o => !o)}
            >
              <Icon name="folder" size={11} />
              <Text size="xs" className={S.saveChipText} title={value.name}>
                {value.name}
              </Text>
              <ActionIcon
                size={14}
                variant="transparent"
                className={S.saveChipClear}
                onClick={handleClear}
                aria-label={t`Reset to auto`}
              >
                <Icon name="close" size={9} />
              </ActionIcon>
            </UnstyledButton>
          ) : (
            <UnstyledButton
              className={S.saveEmpty}
              onClick={() => setIsOpen(o => !o)}
            >
              <Text size="xs" c="text-tertiary">{t`Auto`}</Text>
            </UnstyledButton>
          )}
        </Menu.Target>

        <Menu.Dropdown mt={4}>
          {/* Auto option — always visible at top */}
          <Menu.Item
            leftSection={<Icon name="ai" size={14} />}
            onClick={() => {
              onChange(null);
              setIsOpen(false);
            }}
          >
            <Text size="xs" fw={500}>{t`Auto (new sub-collection)`}</Text>
          </Menu.Item>
          <Menu.Divider />

          {/* Back button + current folder label when navigating */}
          {currentParent && (
            <>
              <UnstyledButton className={S.backButton} onClick={handleGoBack}>
                <Icon name="chevronleft" size={12} />
                <Text size="xs" fw={500} truncate>
                  {currentParent.name}
                </Text>
              </UnstyledButton>

              {/* "Select this collection" option */}
              <Menu.Item
                leftSection={<Icon name="check" size={14} />}
                onClick={() => handleSelect({ id: currentParent.id, name: currentParent.name })}
              >
                <Text size="xs" c="brand" fw={500}>
                  {t`Save here`}
                </Text>
              </Menu.Item>
              <Menu.Divider />
            </>
          )}

          {/* Collection list */}
          <div className={S.scrollArea}>
            {isLoading ? (
              <Menu.Item disabled>
                <Text size="xs" c="text-tertiary">{t`Loading...`}</Text>
              </Menu.Item>
            ) : currentItems.length === 0 ? (
              <Menu.Item disabled>
                <Text size="xs" c="text-tertiary">{t`No sub-collections`}</Text>
              </Menu.Item>
            ) : (
              currentItems.map(node => {
                const hasChildren = node.children && node.children.length > 0;
                return (
                  <Menu.Item
                    key={node.id}
                    leftSection={
                      <Icon
                        name={node.personal_owner_id ? "person" : "folder"}
                        size={14}
                      />
                    }
                    rightSection={
                      hasChildren
                        ? <Icon name="chevronright" size={12} color="var(--mb-color-text-tertiary)" />
                        : undefined
                    }
                    onClick={() =>
                      hasChildren ? handleDrillIn(node) : handleSelect(node)
                    }
                  >
                    <Text size="xs" truncate title={node.name}>
                      {node.name}
                    </Text>
                  </Menu.Item>
                );
              })
            )}
          </div>
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}
