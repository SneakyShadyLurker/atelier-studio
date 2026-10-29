import { useQuery } from '@tanstack/react-query';
import { modelsOpts } from '../api/models';

export function useModels() {
  return useQuery(modelsOpts());
}
