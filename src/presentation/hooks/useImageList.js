import { useCallback, useEffect, useState } from 'react';
import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { listImages } from '../../services/mock/mockImageService';

/**
 * Tải trang đầu danh sách ảnh của một user (hiện dùng service MOCK).
 * Trả về { items, loading, error, reload }.
 *
 * `loading` được suy ra bằng cách so sánh khóa yêu cầu hiện tại với khóa của
 * kết quả gần nhất, nên không cần setState đồng bộ trong effect, và phản hồi
 * cũ (đến muộn) sẽ bị bỏ qua nhờ cờ `cancelled`.
 */
export function useImageList(ownerId, scenario) {
  const [reloadCount, setReloadCount] = useState(0);
  const [result, setResult] = useState({ key: null, items: [], error: null });

  const requestKey = `${ownerId}|${scenario}|${reloadCount}`;

  useEffect(() => {
    if (!ownerId) return undefined;
    let cancelled = false;

    listImages({ ownerId, limit: PAGE_SIZE, scenario })
      .then(({ items }) => {
        if (!cancelled) setResult({ key: requestKey, items, error: null });
      })
      .catch((error) => {
        if (!cancelled) setResult({ key: requestKey, items: [], error });
      });

    return () => {
      cancelled = true;
    };
  }, [ownerId, scenario, requestKey]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const loading = Boolean(ownerId) && result.key !== requestKey;

  return {
    items: loading ? [] : result.items,
    loading,
    error: loading ? null : result.error,
    reload,
  };
}
