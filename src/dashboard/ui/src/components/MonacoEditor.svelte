<script>
  import { createEventDispatcher, onMount } from 'svelte';

  export let value = '';
  export let language = 'plaintext';
  export let height = 320;
  export let readOnly = false;
  export let wordWrap = 'on';
  export let minimap = false;
  export let lineNumbers = 'on';
  export let paddingTop = 10;
  export let wrapperClass = '';

  let container;
  let editor;
  let monacoApi;
  let themeObserver;
  let EditorWorker;
  let JsonWorker;
  let syncingFromEditor = false;
  let syncingFromProps = false;
  let editorSnapshot = value ?? '';

  const dispatch = createEventDispatcher();

  function ensureMonacoEnvironment() {
    globalThis.MonacoEnvironment = {
      getWorker(_, label) {
        if (label === 'json') return new JsonWorker();
        return new EditorWorker();
      },
    };
  }

  async function loadMonaco() {
    const [
      editorWorkerModule,
      jsonWorkerModule,
      ,
      ,
      ,
      ,
      monacoModule,
    ] = await Promise.all([
      import('monaco-editor/esm/vs/editor/editor.worker?worker'),
      import('monaco-editor/esm/vs/language/json/json.worker?worker'),
      import('monaco-editor/esm/vs/language/json/monaco.contribution'),
      import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'),
      import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'),
      import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'),
      import('monaco-editor/esm/vs/editor/editor.api'),
    ]);

    EditorWorker = editorWorkerModule.default;
    JsonWorker = jsonWorkerModule.default;
    return monacoModule;
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs';
  }

  function applyTheme() {
    if (monacoApi) monacoApi.editor.setTheme(getTheme());
  }

  $: heightStyle = typeof height === 'number' ? `${height}px` : height;

  $: if (editor) {
    editor.updateOptions({
      readOnly,
      wordWrap,
      lineNumbers,
      minimap: { enabled: minimap },
      padding: { top: paddingTop, bottom: 10 },
    });
  }

  $: if (editor && monacoApi) {
    const model = editor.getModel();
    if (model && model.getLanguageId() !== language) {
      monacoApi.editor.setModelLanguage(model, language);
    }
  }

  $: if (editor && !syncingFromEditor && !syncingFromProps) {
    const nextValue = value ?? '';
    if (nextValue !== editorSnapshot) {
      syncingFromProps = true;
      editorSnapshot = nextValue;
      const position = editor.getPosition();
      editor.setValue(nextValue);
      if (position) editor.setPosition(position);
      queueMicrotask(() => {
        syncingFromProps = false;
      });
    }
  }

  onMount(async () => {
    monacoApi = await loadMonaco();
    ensureMonacoEnvironment();
    applyTheme();

    editor = monacoApi.editor.create(container, {
      value,
      language,
      theme: getTheme(),
      automaticLayout: true,
      readOnly,
      wordWrap,
      lineNumbers,
      minimap: { enabled: minimap },
      scrollBeyondLastLine: false,
      tabSize: 2,
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, Menlo, monospace',
      padding: { top: paddingTop, bottom: 10 },
    });

    editor.onDidChangeModelContent(() => {
      if (syncingFromProps) return;

      syncingFromEditor = true;
      editorSnapshot = editor.getValue();
      value = editorSnapshot;
      dispatch('change', { value });
      queueMicrotask(() => {
        syncingFromEditor = false;
      });
    });

    editor.onDidBlurEditorText(() => {
      dispatch('blur', { value: editor.getValue() });
    });

    themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      themeObserver?.disconnect();
      editor?.dispose();
    };
  });
</script>

<div bind:this={container} class={`monaco-shell ${wrapperClass}`.trim()} style={`height:${heightStyle};`}></div>

<style>
  .monaco-shell {
    border: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent);
    border-radius: 0.75rem;
    overflow: hidden;
    background: var(--color-base-100);
  }
</style>
