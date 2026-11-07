-- Record how each generated view's layout/prose choice was produced:
-- 'model' (the LLM chose it), 'fallback' (the model's output was
-- unusable or its prose was recycled, so the deterministic fallback
-- ran) or 'rule' (the deterministic rule-based choice used for
-- chat-requested views). Before this column, a fallback was
-- indistinguishable from a model choice — the stored model name was
-- the *intended* model even when the fallback had actually run.
ALTER TABLE generated_views ADD COLUMN choice_source TEXT;
