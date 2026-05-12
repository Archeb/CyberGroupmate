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
  export let extraLibs = [];

  let container;
  let editor;
  let monacoApi;
  let themeObserver;
  let EditorWorker;
  let JsonWorker;
  let TsWorker;
  let extraLibDisposables = [];
  let syncingFromEditor = false;
  let syncingFromProps = false;
  let editorSnapshot = value ?? '';

  const dispatch = createEventDispatcher();

  function ensureMonacoEnvironment() {
    globalThis.MonacoEnvironment = {
      getWorker(_, label) {
        if (label === 'json') return new JsonWorker();
        if (label === 'typescript' || label === 'javascript') return new TsWorker();
        return new EditorWorker();
      },
    };
  }

  async function loadMonaco() {
    const [
      editorWorkerModule,
      jsonWorkerModule,
      tsWorkerModule,
      monacoModule,
    ] = await Promise.all([
      import('monaco-editor/esm/vs/editor/editor.worker?worker'),
      import('monaco-editor/esm/vs/language/json/json.worker?worker'),
      import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
      import('monaco-editor/esm/vs/editor/editor.api'),
      import('monaco-editor/esm/vs/language/json/monaco.contribution'),
      import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'),
      import('monaco-editor/esm/vs/language/typescript/monaco.contribution'),
      import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'),
      import('monaco-editor/esm/vs/editor/contrib/find/browser/findController'),
      import('monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController'),
      import('monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution'),
      import('monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints'),
      import('monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching'),
    ]);

    EditorWorker = editorWorkerModule.default;
    JsonWorker = jsonWorkerModule.default;
    TsWorker = tsWorkerModule.default;
    return monacoModule;
  }

  function configureTypeScriptDefaults() {
    if (!monacoApi?.languages?.typescript) return;
    const ts = monacoApi.languages.typescript;
    const compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      strict: false,
    };
    const diagnosticsOptions = {
      noSyntaxValidation: false,
      noSemanticValidation: false,
      noSuggestionDiagnostics: false,
    };

    ts.typescriptDefaults.setCompilerOptions(compilerOptions);
    ts.javascriptDefaults.setCompilerOptions(compilerOptions);
    ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
    ts.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
    ts.typescriptDefaults.setEagerModelSync(true);
    ts.javascriptDefaults.setEagerModelSync(true);
  }

  function disposeExtraLibs() {
    extraLibDisposables.forEach((item) => item?.dispose?.());
    extraLibDisposables = [];
  }

  function syncExtraLibs() {
    if (!monacoApi?.languages?.typescript) return;
    disposeExtraLibs();
    const libs = Array.isArray(extraLibs) ? extraLibs : [];
    for (const lib of libs) {
      if (!lib?.content) continue;
      const path = lib.path || `file:///extra-lib-${extraLibDisposables.length}.d.ts`;
      extraLibDisposables.push(monacoApi.languages.typescript.typescriptDefaults.addExtraLib(lib.content, path));
      extraLibDisposables.push(monacoApi.languages.typescript.javascriptDefaults.addExtraLib(lib.content, path));
    }
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

  $: if (monacoApi && extraLibs) syncExtraLibs();

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

  onMount(() => {
    let disposed = false;

    (async () => {
      monacoApi = await loadMonaco();
      if (disposed) return;
      ensureMonacoEnvironment();
      configureTypeScriptDefaults();
      syncExtraLibs();
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
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        tabCompletion: 'on',
      });

      editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyF, () => {
        editor.getAction('actions.find')?.run();
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
    })();

    return () => {
      disposed = true;
      themeObserver?.disconnect();
      disposeExtraLibs();
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
