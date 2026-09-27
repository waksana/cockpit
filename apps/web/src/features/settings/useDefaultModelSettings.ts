import { useState } from 'react';
import { cockpitApi, loadSessionDefaults } from '../../net/api';
import { useKeyedAction, useKeyedResource } from '../../lib/useKeyedResource';

// Kept above module composition so adding/removing a module cannot discard edits
// or replace the owner of an in-flight save.
export function useDefaultModelSettings() {
  const resource = useKeyedResource('session-defaults', loadSessionDefaults);
  const action = useKeyedAction('settings:default-model');
  const [draft, setDraft] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const selected = draft ?? resource.data?.modelId ?? '';
  const models = resource.data?.models ?? [];
  const available = models.some(model => model.modelId === selected);
  const canSave = resource.valid && available && !action.busy && selected !== resource.data?.modelId;
  const select = (modelId: string) => {
    setDraft(modelId);
    setSaved(undefined);
  };
  const save = async () => {
    if (!canSave) return;
    setSaved(undefined);
    let committed = selected;
    await action.run(async () => {
      committed = (await cockpitApi.setSessionDefaults(selected)).modelId;
    }, () => {
      setDraft(committed);
      setSaved(committed);
      void resource.refresh();
    });
  };
  const refresh = () => {
    setSaved(undefined);
    return resource.refresh();
  };
  return { resource, action, selected, models, available, canSave, saved, select, save, refresh };
}
