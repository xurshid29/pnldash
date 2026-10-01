-- migrate:up
-- Momentum letter grade (A+ … D) and its 2-minute rolling score, per row per
-- cycle (apps/api/src/services/momentum-grade.ts). Persisted so the LIVE grade
-- can be re-graded against forward outcomes the same way it was validated
-- offline (fit Aug 2026 / test Sep 2026). Additive + nullable: the previous
-- API image keeps writing rows without these columns during a rollout.
alter table screener_results
    add column grade varchar(2),
    add column grade_score real;

-- migrate:down
alter table screener_results
    drop column grade,
    drop column grade_score;
