import type { MouseEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { t } from "ttag";

import api from "metabase/lib/api";
import { ActionIcon, Box, Icon, Menu, Text, Tooltip, UnstyledButton } from "metabase/ui";

import S from "./AgentDatasourcePicker.module.css";

export interface AgentDatasource {
  type: "database" | "table";
  id: number;
  name: string;
  db_id?: number;
}

interface Database {
  id: number;
  name: string;
}

interface Table {
  id: number;
  name: string;
  display_name: string;
  db_id: number;
}

interface AgentDatasourcePickerProps {
  value: AgentDatasource | null;
  onChange: (value: AgentDatasource | null) => void;
}

export function AgentDatasourcePicker({ value, onChange }: AgentDatasourcePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [databases, setDatabases] = useState<Database[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [drillDb, setDrillDb] = useState<Database | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch databases on first open
  useEffect(() => {
    if (!isOpen || databases.length > 0) return;
    setIsLoading(true);
    api
      .GET("/api/database")({})
      .then((data: unknown) => {
        const d = data as { data?: Database[] };
        setDatabases(Array.isArray(d.data) ? d.data : []);
      })
      .catch(() => setDatabases([]))
      .finally(() => setIsLoading(false));
  }, [isOpen, databases.length]);

  // Fetch tables when drilling into a database
  useEffect(() => {
    if (!drillDb) {
      setTables([]);
      return;
    }
    setIsLoading(true);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (api.sessionToken) {
      headers["X-Metabase-Session"] = api.sessionToken;
    }
    fetch(`/api/database/${drillDb.id}?include=tables`, { headers })
      .then(r => r.json())
      .then((data: unknown) => {
        const d = data as { tables?: Table[] };
        setTables(Array.isArray(d.tables) ? d.tables : []);
      })
      .catch(() => setTables([]))
      .finally(() => setIsLoading(false));
  }, [drillDb]);

  // Reset drill state on close
  useEffect(() => {
    if (!isOpen) setDrillDb(null);
  }, [isOpen]);

  const handleSelectDb = useCallback(
    (db: Database) => {
      onChange({ type: "database", id: db.id, name: db.name });
      setIsOpen(false);
    },
    [onChange],
  );

  const handleSelectTable = useCallback(
    (table: Table) => {
      onChange({ type: "table", id: table.id, name: table.display_name || table.name, db_id: table.db_id });
      setIsOpen(false);
    },
    [onChange],
  );

  const handleClear = (e: MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  return (
    <Box className={S.datasourceBar}>
      <Menu
        opened={isOpen}
        onClose={() => setIsOpen(false)}
        closeOnItemClick={false}
        position="bottom-start"
        width={240}
      >
        <Menu.Target>
          {value ? (
            <UnstyledButton className={S.datasourceChip} onClick={() => setIsOpen((o: boolean) => !o)}>
              <Icon name={value.type === "table" ? "table2" : "database"} size={11} />
              <Text size="xs" lh={1} className={S.datasourceChipText} title={value.name}>
                {value.name}
              </Text>
              <ActionIcon
                size={14}
                variant="transparent"
                className={S.datasourceChipClear}
                onClick={handleClear}
                aria-label={t`Remove datasource`}
              >
                <Icon name="close" size={9} />
              </ActionIcon>
            </UnstyledButton>
          ) : (
            <Tooltip label={t`Select database or table`} position="top" withArrow>
              <UnstyledButton className={S.datasourceEmpty} onClick={() => setIsOpen((o: boolean) => !o)}>
                <Icon name="database" size={10} className={S.datasourceAddIcon} />
                <Text size="xs" c="text-tertiary" lh={1}>{t`DB`}</Text>
              </UnstyledButton>
            </Tooltip>
          )}
        </Menu.Target>

        <Menu.Dropdown mt={4}>
          {drillDb ? (
            <>
              {/* Back to databases */}
              <UnstyledButton className={S.backButton} onClick={() => setDrillDb(null)}>
                <Icon name="chevronleft" size={12} />
                <Text size="xs" fw={500} truncate>{drillDb.name}</Text>
              </UnstyledButton>
              <Menu.Divider />

              {/* Select the whole database */}
              <Menu.Item
                leftSection={<Icon name="database" size={14} />}
                onClick={() => handleSelectDb(drillDb)}
              >
                <Text size="xs" c="brand" fw={500}>{t`Use whole database`}</Text>
              </Menu.Item>
              <Menu.Divider />

              {/* Tables */}
              <div className={S.scrollArea}>
                {isLoading ? (
                  <Menu.Item disabled>
                    <Text size="xs" c="text-tertiary">{t`Loading…`}</Text>
                  </Menu.Item>
                ) : tables.length === 0 ? (
                  <Menu.Item disabled>
                    <Text size="xs" c="text-tertiary">{t`No tables`}</Text>
                  </Menu.Item>
                ) : (
                  tables.map(table => (
                    <Menu.Item
                      key={table.id}
                      leftSection={<Icon name="table2" size={14} />}
                      onClick={() => handleSelectTable(table)}
                    >
                      <Text size="xs" truncate title={table.display_name || table.name}>
                        {table.display_name || table.name}
                      </Text>
                    </Menu.Item>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className={S.scrollArea}>
              {isLoading ? (
                <Menu.Item disabled>
                  <Text size="xs" c="text-tertiary">{t`Loading…`}</Text>
                </Menu.Item>
              ) : databases.length === 0 ? (
                <Menu.Item disabled>
                  <Text size="xs" c="text-tertiary">{t`No databases`}</Text>
                </Menu.Item>
              ) : (
                databases.map(db => (
                  <Menu.Item
                    key={db.id}
                    leftSection={<Icon name="database" size={14} />}
                    rightSection={<Icon name="chevronright" size={12} color="var(--mb-color-text-tertiary)" />}
                    onClick={() => setDrillDb(db)}
                  >
                    <Text size="xs" truncate title={db.name}>{db.name}</Text>
                  </Menu.Item>
                ))
              )}
            </div>
          )}
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}
