import { useCallback, useEffect, useState } from 'react';
import { analyze, detect, parse, readTable } from '../engine';
import type { Detection, ParseResult, RawTable, Review as ReviewT } from '../engine';
import Landing from './Landing';
import ColumnCheck from './ColumnCheck';
import ReviewPage from './ReviewPage';
import { mockReview } from './mockReview';

const MAX_BYTES = 5 * 1024 * 1024;
const OK_EXT = /\.(csv|tsv|xlsx|xls)$/i;

type Source = { data: ArrayBuffer; fileName: string } | null;

type ReviewStage = { kind: 'review'; fileName: string; table: RawTable | null; detection: Detection | null; parsed: ParseResult | null; review: ReviewT };

type Stage =
  | { kind: 'landing' }
  | { kind: 'loading'; label: string }
  | { kind: 'mapping'; table: RawTable; detection: Detection; error: string | null; back: ReviewStage | null }
  | ReviewStage;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong while reading this file.';
}

export default function App() {
  const [stage, setStage] = useState<Stage>({ kind: 'landing' });
  const [source, setSource] = useState<Source>(null);
  const [landingError, setLandingError] = useState<string | null>(null);

  const toLanding = useCallback((error: string | null = null) => {
    setSource(null);
    setLandingError(error);
    setStage({ kind: 'landing' });
    window.scrollTo({ top: 0 });
  }, []);

  const runParse = useCallback((table: RawTable, detection: Detection, back: ReviewStage | null): void => {
    try {
      const parsed = parse(table, detection);
      if (parsed.trades.length === 0) {
        throw new Error('We could not find any complete trades in this file. Check that the columns are matched correctly.');
      }
      const review = analyze(parsed);
      setStage({ kind: 'review', fileName: table.fileName, table, detection, parsed, review });
      window.scrollTo({ top: 0 });
    } catch (e) {
      setStage({ kind: 'mapping', table, detection, error: errMsg(e), back });
    }
  }, []);

  const processBytes = useCallback(
    (data: ArrayBuffer, fileName: string) => {
      setSource({ data, fileName });
      setLandingError(null);
      setStage({ kind: 'loading', label: `Reading ${fileName}…` });
      // let the loading state paint before the synchronous parse
      setTimeout(() => {
        try {
          const table = readTable(data, fileName);
          const detection = detect(table);
          if (detection.format === null || detection.confidence === 'low') {
            setStage({ kind: 'mapping', table, detection, error: null, back: null });
            window.scrollTo({ top: 0 });
            return;
          }
          runParse(table, detection, null);
        } catch (e) {
          toLanding(errMsg(e));
        }
      }, 30);
    },
    [runParse, toLanding],
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (!OK_EXT.test(file.name)) {
        setLandingError('That file type is not supported. Please upload a CSV, TSV, XLSX or XLS file.');
        return;
      }
      if (file.size > MAX_BYTES) {
        setLandingError('That file is larger than 5 MB. A month of orders is usually far smaller. Try exporting a single month.');
        return;
      }
      if (file.size === 0) {
        setLandingError('That file is empty.');
        return;
      }
      try {
        processBytes(await file.arrayBuffer(), file.name);
      } catch {
        setLandingError('We could not read that file. Please try again.');
      }
    },
    [processBytes],
  );

  const handleSample = useCallback(
    async (path: string, fileName: string) => {
      setLandingError(null);
      setStage({ kind: 'loading', label: 'Loading sample…' });
      try {
        const res = await fetch(path);
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || type.includes('text/html')) throw new Error('missing');
        processBytes(await res.arrayBuffer(), fileName);
      } catch {
        toLanding('We could not load the sample file. Please try uploading your own file.');
      }
    },
    [processBytes, toLanding],
  );

  const handleSheet = useCallback(
    (sheet: string) => {
      if (!source) return;
      try {
        const table = readTable(source.data, source.fileName, sheet);
        const detection = detect(table);
        setStage((prev) => ({
          kind: 'mapping',
          table,
          detection,
          error: null,
          back: prev.kind === 'mapping' ? prev.back : null,
        }));
      } catch (e) {
        setStage((prev) => (prev.kind === 'mapping' ? { ...prev, error: errMsg(e) } : prev));
      }
    },
    [source],
  );

  // Dev helper: /?mock=1 shows a hand-built review without the engine pipeline.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('mock')) {
      setStage({ kind: 'review', fileName: 'mock-tradebook.csv', table: null, detection: null, parsed: null, review: mockReview });
    }
  }, []);

  if (stage.kind === 'loading') {
    return (
      <div className="loading-screen" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>{stage.label}</p>
      </div>
    );
  }

  if (stage.kind === 'mapping') {
    return (
      <ColumnCheck
        key={`${stage.table.fileName}|${stage.table.sheet ?? ''}`}
        table={stage.table}
        initial={stage.detection}
        error={stage.error}
        canPickSheet={!!source}
        onSheet={handleSheet}
        onAnalyse={(d) => runParse(stage.table, d, stage.back)}
        onBack={() => (stage.back ? setStage(stage.back) : toLanding())}
        backLabel={stage.back ? 'Back to review' : 'Back'}
      />
    );
  }

  if (stage.kind === 'review') {
    const { table, detection } = stage;
    const current = stage;
    return (
      <ReviewPage
        fileName={stage.fileName}
        review={stage.review}
        parsed={stage.parsed}
        onCheckColumns={table && detection ? () => setStage({ kind: 'mapping', table, detection, error: null, back: current }) : undefined}
        onNew={() => toLanding()}
      />
    );
  }

  return <Landing error={landingError} onFile={handleFile} onSample={handleSample} />;
}
