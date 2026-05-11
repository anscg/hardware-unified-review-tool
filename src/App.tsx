import { useState, useEffect, useRef } from 'react';
import UrlInput from './components/UrlInput';
import FileExplorer from './components/FileExplorer';
import ComponentTree from './components/ComponentTree';
import ModelViewer from './components/ModelViewer';
import KiCadViewer from './components/KiCadViewer';
import EasyEdaViewer from './components/EasyEdaViewer';
import GerberViewer from './components/GerberViewer';
import LoadingOverlay from './components/LoadingOverlay';
import LandingPage from './components/LandingPage';
import { useStore } from './store/useStore';
import { isGithubUrl, fetchRepositoryFiles } from './utils/github';
import { Analytics } from '@vercel/analytics/react';
import './App.css';

function App() {
  const {
    files,
    selectedFile,
    setSelectedFile,
    resolverMap,
    performanceMode,
    togglePerformanceMode,
    setGithubUrl,
    setFiles,
    setResolverMap,
    setIsLoading,
    setError,
  } = useStore();
  const [showViewer, setShowViewer] = useState(false);
  const autoLoadedRef = useRef(false);

  // Auto-load from ?repo= query parameter
  useEffect(() => {
    if (autoLoadedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const repoUrl = params.get('repo');
    if (!repoUrl || !isGithubUrl(repoUrl)) return;

    autoLoadedRef.current = true;
    setGithubUrl(repoUrl);
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        const store = useStore.getState();
        const { files, resolverMap } = await fetchRepositoryFiles(
          store.repoOwner,
          store.repoName,
          store.repoBranch,
          store.repoPath
        );
        if (files.length === 0) {
          setError('No hardware files found in this repository');
        } else {
          setFiles(files);
          setResolverMap(resolverMap);
          setShowViewer(true);
        }
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch files');
        setIsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (files.length > 0 && !selectedFile) {
      setSelectedFile(files[0]);
    }
  }, [files, selectedFile, setSelectedFile]);

  if (!showViewer && files.length === 0) {
    return (
      <>
        <LandingPage onLoaded={() => setShowViewer(true)} />
        <LoadingOverlay />
        <Analytics />
      </>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">HURT</span>
        <UrlInput />
        <button
          className={`perf-toggle ${performanceMode ? 'enabled' : ''}`}
          onClick={togglePerformanceMode}
          title="Reduce rendering quality for faster loading and smoother interaction on large models"
        >
          Performance {performanceMode ? 'ON' : 'OFF'}
        </button>
      </header>

      <div className="app-content">
        {files.length > 0 && (
          <aside className="sidebar">
            <FileExplorer />
            {selectedFile?.kind === 'model' && <ComponentTree />}
          </aside>
        )}

        <main className="main-content">
          {selectedFile ? (
            selectedFile.kind === 'kicad' ? (
              <KiCadViewer
                fileUrl={selectedFile.url}
                filePath={selectedFile.path}
                fileName={selectedFile.name}
                resolverMap={resolverMap}
              />
            ) : selectedFile.kind === 'easyeda' ? (
              <EasyEdaViewer file={selectedFile} />
            ) : selectedFile.kind === 'gerber' ? (
              <GerberViewer file={selectedFile} />
            ) : (
              <ModelViewer />
            )
          ) : (
            <div className="empty-state">
              <p>Select a file from the sidebar</p>
            </div>
          )}
        </main>
      </div>

      <LoadingOverlay />
      <Analytics />
    </div>
  );
}

export default App;
