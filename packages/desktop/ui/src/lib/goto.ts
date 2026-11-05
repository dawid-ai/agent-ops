/** The window event that asks App to open the Add agent dialog. */
export const ADD_AGENT_EVENT = 'ops:add-agent';

/** What an Add agent request carries: the id to fill in, and who to tell the id that was added. */
export interface AddAgentRequest {
  id: string;
  onAdded?: (id: string) => void;
}

/**
 * Opens the Add agent dialog filled in for `id`, from anywhere: pickers have no `nav`. App shows
 * it above any open dialog and leaves that dialog mounted, so nothing typed in it is lost.
 * `onAdded` gets the id that was added, which the person may have changed in the dialog.
 */
export function openAddAgent(id: string, onAdded?: (id: string) => void): void {
  window.dispatchEvent(
    new CustomEvent<AddAgentRequest>(ADD_AGENT_EVENT, { detail: { id, onAdded } }),
  );
}
