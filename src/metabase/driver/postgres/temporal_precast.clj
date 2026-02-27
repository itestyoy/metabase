(ns metabase.driver.postgres.temporal-precast
  "Вариант PostgreSQL-драйвера, который проталкивает temporal-bucketing
  (date_trunc и т.п.) во внутренний SELECT вложенного запроса.

  Стандартный драйвер после nest-expressions делает так:

    SELECT date_trunc('month', source.created_at) AS created_at_month, count(*)
    FROM (
      SELECT created_at                    -- <-- сырое поле
      FROM my_table
    ) AS source
    GROUP BY date_trunc('month', source.created_at)

  Этот драйвер делает так:

    SELECT date_trunc('month', source.created_at) AS created_at_month, count(*)
    FROM (
      SELECT date_trunc('month', created_at) AS created_at  -- <-- каст внутри
      FROM my_table
    ) AS source
    GROUP BY date_trunc('month', source.created_at)

  Двойной date_trunc идемпотентен, поэтому внешний запрос не меняется.
  Алиас во внутреннем SELECT остаётся прежним (created_at, не created_at_month),
  потому что add-alias-info отработал ДО добавления temporal-unit — именно это
  сохраняет совместимость с внешним запросом."
  (:require
   [metabase.driver :as driver]
   [metabase.driver-api.core :as driver-api]
   [metabase.driver.sql.query-processor :as sql-qp]))

(driver/register! :postgres-precast, :parent :postgres)

;; ────────────────────────────────────────────────────────────────────────────
;; Ключ-маркер, который мы добавляем в options поля внутреннего запроса.
;; Хранит temporal-unit, который нужно применить при компиляции в SQL.
;; Выбираем namespaced keyword в этом же ns, чтобы не пересекаться с
;; существующими ключами Metabase.
;; ────────────────────────────────────────────────────────────────────────────
(def ^:private pre-bucket-unit ::pre-bucket-temporal-unit)

;; ────────────────────────────────────────────────────────────────────────────
;; MBQL4-трансформация: добавляем маркер в поля source-query
;; ────────────────────────────────────────────────────────────────────────────

(defn- breakout-temporal-units
  "Возвращает map {source-alias -> temporal-unit} для всех breakout-полей
  внешнего MBQL4-запроса, у которых есть :temporal-unit."
  [outer-query]
  (into {}
        (keep (fn [[_tag _id opts :as _clause]]
                (when-let [unit (:temporal-unit opts)]
                  ;; source-alias — это алиас, под которым внутренний SELECT
                  ;; отдаёт это поле; именно его мы ищем во внутреннем :fields
                  (when-let [src (get opts driver-api/qp.add.source-alias)]
                    [src unit]))))
        (:breakout outer-query)))

(defn- mark-inner-fields
  "Для каждого поля из source-query, чей desired-alias совпадает с каким-либо
  source-alias из внешних breakouts, добавляет маркер ::pre-bucket-temporal-unit.
  Поля без совпадения и поля, у которых уже есть :temporal-unit, не трогаем."
  [source-query temporal-units]
  (update source-query :fields
          (fn [fields]
            (mapv (fn [[tag id opts :as field-clause]]
                    (let [alias (get opts driver-api/qp.add.desired-alias)
                          unit  (get temporal-units alias)]
                      (if (and (= tag :field)
                               unit
                               (nil? (:temporal-unit opts)) ; не дублируем, если уже есть
                               (nil? (get opts pre-bucket-unit)))
                        [tag id (assoc opts pre-bucket-unit unit)]
                        field-clause)))
                  (or fields [])))))

(defn- push-temporal-bucketing-to-source-query
  "Главная трансформация. Принимает MBQL4 inner-query (результат :query после
  ->legacy-MBQL). Если запрос содержит source-query и в breakouts есть
  temporal-unit'ы, помечает нужные поля source-query маркером pre-bucket-unit."
  [inner-query]
  (if-not (:source-query inner-query)
    inner-query
    (let [units (breakout-temporal-units inner-query)]
      (if (empty? units)
        inner-query
        (update inner-query :source-query mark-inner-fields units)))))

;; ────────────────────────────────────────────────────────────────────────────
;; Переопределение preprocess — минимальный diff от базового :sql
;; ────────────────────────────────────────────────────────────────────────────

(defmethod sql-qp/preprocess :postgres-precast
  [_driver mbql5-query]
  (-> mbql5-query
      ;; Всё стандартное — берём из базовой реализации :sql
      driver-api/nest-breakouts-in-stages-with-window-aggregation
      driver-api/nest-expressions
      driver-api/add-alias-info
      driver-api/->legacy-MBQL
      :query
      ;; Единственное отличие: после конвертации в MBQL4 добавляем маркеры
      push-temporal-bucketing-to-source-query))

;; ────────────────────────────────────────────────────────────────────────────
;; Переопределение ->honeysql для :field — применяем pre-bucket при компиляции
;; ────────────────────────────────────────────────────────────────────────────

(defmethod sql-qp/->honeysql [:postgres-precast :field]
  [driver [tag id opts :as field-clause]]
  ;; Postgres переопределяет [:postgres :field] для обработки money/JSON-полей,
  ;; поэтому цепляемся именно к нему, а не к [:sql :field].
  (let [postgres-field (get-method sql-qp/->honeysql [:postgres :field])]
    (if-let [unit (get opts pre-bucket-unit)]
      ;; Поле помечено: убираем маркер, получаем базовый HoneySQL-идентификатор
      ;; через postgres-реализацию (она обработает money/JSON корректно),
      ;; затем оборачиваем в temporal-bucketing.
      ;; Алиас при этом остаётся тем, что выставил add-alias-info (сырое имя
      ;; поля, например "created_at"), а не bucketed-вариант ("created_at_month").
      (let [stripped  [tag id (dissoc opts pre-bucket-unit)]
            base-hsql (postgres-field driver stripped)]
        (sql-qp/apply-temporal-bucketing driver {:temporal-unit unit} base-hsql))
      ;; Обычный случай — делегируем в postgres-реализацию
      (postgres-field driver field-clause))))
