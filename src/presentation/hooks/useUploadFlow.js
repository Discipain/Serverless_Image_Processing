import { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialUploadState, toErrorView, uploadFlowReducer } from './uploadFlowReducer';
import { useUploadServices } from './useUploadServices';

/**
 * Điều khiển một lần upload (MOCK ở H4A) và giữ `session` của lần thất bại gần nhất để thử lại ĐÚNG bước hỏng
 * (confirm lỗi -> chỉ confirm lại, cùng imageId, không nén/upload lại).
 * Trả về { state, selectFile, retry, cancel, reset }.
 */
export function useUploadFlow() {
  const services = useUploadServices();
  const [state, dispatch] = useReducer(uploadFlowReducer, initialUploadState);
  const sessionRef = useRef(null); // session của lần lỗi gần nhất (không đưa vào state/render)
  const controllerRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      controllerRef.current?.abort(); // rời trang: hủy việc đang chạy
    };
  }, []);

  const execute = useCallback(
    async (args) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      // Chỉ cập nhật giao diện khi còn mounted và đây vẫn là lần chạy hiện tại.
      const safe = (action) => {
        if (aliveRef.current && controllerRef.current === controller) dispatch(action);
      };
      try {
        const outcome = await services.uploadImage({
          ...args,
          signal: controller.signal,
          onStage: (event) => safe({ type: 'STAGE', ...event }),
          onProgress: (progress) => safe({ type: 'PROGRESS', ...progress }),
        });
        sessionRef.current = null;
        safe({ type: 'DONE', result: outcome });
      } catch (error) {
        sessionRef.current = error?.details?.session ?? null;
        safe({ type: 'FAILED', error: toErrorView(error) });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [services],
  );

  const selectFile = useCallback(
    (file) => {
      if (!file || controllerRef.current) return; // đang chạy: bỏ qua
      sessionRef.current = null;
      dispatch({ type: 'START', fileName: file.name });
      return execute({ file });
    },
    [execute],
  );

  const retry = useCallback(() => {
    const session = sessionRef.current;
    if (!session || controllerRef.current) return;
    dispatch({ type: 'RESUME' });
    return execute({ session });
  }, [execute]);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    sessionRef.current = null;
    dispatch({ type: 'RESET' });
  }, []);

  return { state, selectFile, retry, cancel, reset };
}
