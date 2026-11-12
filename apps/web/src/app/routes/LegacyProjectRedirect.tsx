import { Navigate, useLocation, useParams } from "react-router-dom";

export function LegacyProjectRedirect() {
  const { pid, "*": rest = "" } = useParams();
  const location = useLocation();
  return <Navigate to={`/projects/${pid}/${rest}${location.search}${location.hash}`} replace />;
}
