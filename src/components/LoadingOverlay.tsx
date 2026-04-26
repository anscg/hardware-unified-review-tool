import { useStore } from '../store/useStore';

export default function LoadingOverlay() {
  const { isLoading, error, files } = useStore();

  // Only show the full-screen overlay during repo fetching (before files are loaded).
  // Once files exist, ModelViewer handles its own inline loading indicator.
  const showLoading = isLoading && files.length === 0;

  if (!showLoading && !error) return null;

  return (
    <div className="loading-overlay">
      {showLoading && (
        <div className="loading-spinner">
          <div className="spinner"></div>
          <div className="loading-bar">
            <div className="loading-bar-track">
              <div className="loading-bar-fill indeterminate" />
            </div>
          </div>
          <p>Loading repository...</p>
        </div>
      )}
      {error && (
        <div className="error-message">
          <div className="error-icon">⚠️</div>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
