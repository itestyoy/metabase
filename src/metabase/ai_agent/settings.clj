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
   GPT-5 family (flagship, Mar 2026): gpt-5.4, gpt-5.4-pro, gpt-5.3, gpt-5.2, gpt-5-mini.
   Reasoning (o-series): o4-mini, o3, o3-mini.
   GPT-4.1 family: gpt-4.1, gpt-4.1-mini, gpt-4.1-nano."
  :visibility :authenticated
  :type :string
  :default "gpt-5.4"
  :export? false)

(settings/defsetting ai-agent-enabled
  "Whether the AI Agent feature is enabled."
  :visibility :authenticated
  :type :boolean
  :default true
  :export? false)
