<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
  import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
  import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
  import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
  import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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
  let syncingFromEditor = false;

  const dispatch = createEventDispatcher();

  function ensureMonacoEnvironment() {
    globalThis.MonacoEnvironment = {
      getWorker(_, label) {
        if (label === 'json') return new jsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        return new editorWorker();
      },
    };
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

  $: if (editor && !syncingFromEditor) {
    const currentValue = editor.getValue();
    if (value !== currentValue) {
      const position = editor.getPosition();
      editor.setValue(value ?? '');
      if (position) editor.setPosition(position);
    }
  }

  onMount(async () => {
    ensureMonacoEnvironment();
    monacoApi = await import('monaco-editor');
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
      syncingFromEditor = true;
      value = editor.getValue();
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