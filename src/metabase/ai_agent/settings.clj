(ns metabase.ai-agent.settings
  "Settings for the AI Agent module."
  (:require
   [metabase.settings.core :refer [defsetting]]
   [metabase.util.i18n :refer [deferred-tru]]))

(set! *warn-on-reflection* true)

(defsetting ai-agent-openai-api-key
  (deferred-tru "OpenAI API key used by the AI Agent feature.")
  :visibility  :admin
  :sensitive?  true
  :type        :string
  :default     nil
  :export?     false)

(defsetting ai-agent-openai-model
  (deferred-tru "OpenAI model used by the AI Agent (e.g. gpt-5.4, o4-mini, gpt-4.1).")
  :visibility  :authenticated
  :type        :string
  :encryption  :no
  :default     "gpt-5.4"
  :export?     false)

(defsetting ai-agent-enabled
  (deferred-tru "Whether the AI Agent feature is enabled.")
  :visibility  :authenticated
  :type        :boolean
  :default     true
  :export?     false)
