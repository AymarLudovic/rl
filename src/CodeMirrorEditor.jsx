import { acceptCompletion, autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
  showTooltip,
  tooltips,
  type Tooltip,
} from '@codemirror/view';
import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react';

const classNames = (...classes) => classes.filter(Boolean).join(' ');

const createScopedLogger = (name) => ({
  trace: (message) => console.log(`[${name}] ${message}`),
  warn: (message) => console.warn(`[${name}] ${message}`),
});

const logger = createScopedLogger('CodeMirrorEditor');

const readOnlyTooltipStateEffect = StateEffect.define();

const editableTooltipField = StateField.define({
  create: () => [],
  update(tooltips, transaction) {
    if (!transaction.state.readOnly) {
      return [];
    }

    for (const effect of transaction.effects) {
      if (effect.is(readOnlyTooltipStateEffect) && effect.value) {
        return getReadOnlyTooltip(transaction.state);
      }
    }

    return [];
  },
  provide: (field) => {
    return showTooltip.computeN([field], (state) => state.field(field));
  },
});

const editableStateEffect = StateEffect.define();

const editableStateField = StateField.define({
  create() {
    return true;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(editableStateEffect)) {
        return effect.value;
      }
    }

    return value;
  },
});

const getTheme = () => {
  return [
    EditorView.baseTheme({
      '.cm-content': {
        padding: '4px 6px 4px 8px',
        outline: 'none',
      },
      '.cm-line': {
        padding: 0,
      },
      '.cm-gutters': {
        border: 'none',
      },
    }),
  ];
};

const getLanguage = async (filePath) => {
  const fileExtension = filePath.split('.').pop();

  switch (fileExtension) {
    case 'js':
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts':
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'md':
      return (await import('@codemirror/lang-markdown')).markdown();
    default:
      return null;
  }
};

const indentKeyBinding = {
  key: 'Mod-i',
  run: () => {
    return true;
  },
};

const reconfigureTheme = (theme) => {
  return StateEffect.reconfigure(EditorView.themeClasses.of([theme]));
};

const BinaryContent = () => {
  return <div>Binary Content</div>;
};

const debounce = (func, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
};

const renderLogger = {
  trace: (message) => console.log(`[Render] ${message}`),
};

function newEditorState(
  content,
  settings,
  onScrollRef,
  debounceScroll,
  onFileSaveRef,
  extensions,
) {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorView.domEventHandlers({
        scroll: debounce((event, view) => {
          if (event.target !== view.scrollDOM) {
            return;
          }

          onScrollRef.current?.({ left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop });
        }, debounceScroll),
        keydown: (event, view) => {
          if (view.state.readOnly) {
            view.dispatch({
              effects: [readOnlyTooltipStateEffect.of(event.key !== 'Escape')],
            });

            return true;
          }

          return false;
        },
      }),
      getTheme(),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Tab', run: acceptCompletion },
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onFileSaveRef.current?.();
            return true;
          },
        },
        indentKeyBinding,
      ]),
      indentUnit.of('\t'),
      autocompletion({
        closeOnBlur: false,
      }),
      tooltips({
        position: 'absolute',
        parent: document.body,
        tooltipSpace: (view) => {
          const rect = view.dom.getBoundingClientRect();

          return {
            top: rect.top - 50,
            left: rect.left,
            bottom: rect.bottom,
            right: rect.right + 10,
          };
        },
      }),
      closeBrackets(),
      lineNumbers(),
      scrollPastEnd(),
      dropCursor(),
      drawSelection(),
      bracketMatching(),
      EditorState.tabSize.of(settings?.tabSize ?? 2),
      indentOnInput(),
      editableTooltipField,
      editableStateField,
      EditorState.readOnly.from(editableStateField, (editable) => !editable),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter({
        markerDOM: (open) => {
          const icon = document.createElement('div');

          icon.className = `fold-icon ${open ? 'i-ph-caret-down-bold' : 'i-ph-caret-right-bold'}`;

          return icon;
        },
      }),
      ...extensions,
    ],
  });
}

function setNoDocument(view) {
  view.dispatch({
    selection: { anchor: 0 },
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: '',
    },
  });

  view.scrollDOM.scrollTo(0, 0);
}

function setEditorDocument(
  view,
  editable,
  languageCompartment,
  autoFocus,
  doc,
) {
  if (doc.value !== view.state.doc.toString()) {
    view.dispatch({
      selection: { anchor: 0 },
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: doc.value,
      },
    });
  }

  view.dispatch({
    effects: [editableStateEffect.of(editable && !doc.isBinary)],
  });

  getLanguage(doc.filePath).then((languageSupport) => {
    if (!languageSupport) {
      return;
    }

    view.dispatch({
      effects: [languageCompartment.reconfigure([languageSupport])],
    });

    requestAnimationFrame(() => {
      const currentLeft = view.scrollDOM.scrollLeft;
      const currentTop = view.scrollDOM.scrollTop;
      const newLeft = doc.scroll?.left ?? 0;
      const newTop = doc.scroll?.top ?? 0;

      const needsScrolling = currentLeft !== newLeft || currentTop !== newTop;

      if (autoFocus && editable) {
        if (needsScrolling) {
          // we have to wait until the scroll position was changed before we can set the focus
          view.scrollDOM.addEventListener(
            'scroll',
            () => {
              view.focus();
            },
            { once: true },
          );
        } else {
          // if the scroll position is still the same we can focus immediately
          view.focus();
        }
      }

      view.scrollDOM.scrollTo(newLeft, newTop);
    });
  });
}

function getReadOnlyTooltip(state) {
  if (!state.readOnly) {
    return [];
  }

  return state.selection.ranges
    .filter((range) => {
      return range.empty;
    })
    .map((range) => {
      return {
        pos: range.head,
        above: true,
        strictSide: true,
        arrow: true,
        create: () => {
          const divElement = document.createElement('div');
          divElement.className = 'cm-readonly-tooltip';
          divElement.textContent = 'Cannot edit file while AI response is being generated';

          return { dom: divElement };
        },
      };
    });
}

const CodeMirrorEditor = memo(
  ({
    value,
  }) => {
    renderLogger.trace('CodeMirrorEditor');

    const [languageCompartment] = useState(new Compartment());

    const containerRef = useRef(null);
    const viewRef = useRef();
    const docRef = useRef({ value: value, isBinary: false, filePath: 'index.js', scroll: { top: 0, left: 0 } });
    const onScrollRef = useRef();
    const onFileSaveRef = useRef();

    useEffect(() => {
      const view = new EditorView({
        parent: containerRef.current,
      });

      viewRef.current = view;

      return () => {
        viewRef.current?.destroy();
        viewRef.current = undefined;
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;

      if (!view) {
        return;
      }

      const settings = { tabSize: 2 };
      const theme = 'light';
      const editable = true;
      const autoFocusOnDocumentChange = false;
      const doc = { value: value, isBinary: false, filePath: 'index.js', scroll: { top: 0, left: 0 } };

      let state = newEditorState(doc.value, settings, onScrollRef, 100, onFileSaveRef, [
        languageCompartment.of([]),
      ]);

      view.setState(state);

      setEditorDocument(
        view,
        editable,
        languageCompartment,
        autoFocusOnDocumentChange,
        doc,
      );
    }, [value]);

    return (
      React.createElement("div", { className: classNames('relative h-full') },
        React.createElement("div", { className: "h-full overflow-hidden", ref: containerRef })
      )
    );
  }
);

export default CodeMirrorEditor;
