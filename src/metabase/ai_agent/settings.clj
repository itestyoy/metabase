(ns metabase.ai-agent.settings
  "Settings for the AI Agent module."
  (:require
   [metabase.settings.core :as settings]))

(set! *warn-on-reflection* true)

(settings/defsetting ai-agent-openai-api-key
  "OpenAI API key used by the AI Agent feature."
  :visibility :admin
  :sensitive? true
  :type :string
  :default nil
  :export? false)

(settings/defsetting ai-agent-openai-model
  "OpenAI model used by the AI Agent.
   Supported values: gpt-4.1, gpt-4.1-mini, gpt-4.1-nano,
                     gpt-4o, gpt-4o-mini,
                     o3, o3-mini, o4-mini."
  :visibility :authenticated
  :type :string
  :default "gpt-4.1"
  :export? false)

(settings/defsetting ai-agent-enabled
  "Whether the AI Agent feature is enabled."
  :visibility :authenticated
  :type :boolean
  :default true
  :export? false)
