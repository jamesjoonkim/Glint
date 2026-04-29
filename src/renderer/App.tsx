import { SelectionOverlay } from './components/SelectionOverlay/index.js';
import { ResponseWindow } from './components/ResponseWindow/index.js';
import { HistoryPanel } from './components/HistoryPanel/index.js';
import { FirstRun } from './windows/FirstRun/index.js';
import { Settings } from './windows/Settings/index.js';

function getView(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('view') ?? 'main';
}

export function App(): JSX.Element {
  const view = getView();

  if (view === 'overlay') return <SelectionOverlay />;
  if (view === 'response') return <ResponseWindow />;
  if (view === 'history') return <HistoryPanel />;
  if (view === 'settings') return <Settings />;
  if (view === 'first-run') return <FirstRun />;

  // Main window = dashboard. HistoryPanel renders the gallery of past
  // captures + lets you reopen any thread in the response window.
  return <HistoryPanel />;
}
