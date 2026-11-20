# PROMPT PHÂN TÍCH FRONTEND REACT

Bạn là Senior Frontend Engineer/React Reviewer. Hãy kiểm tra trực tiếp repository hiện mở: https://github.com/Discipain/Serverless_Image_Processing.git. Đọc CLAUDE.md tại root, README, package.json, cây thư mục, frontend source, và SCHEMA.md / CONTRACT.md / TEST-PLAN.md nếu có. Đối chiếu với tài liệu PDF "Hệ thống xử lý ảnh tự động (Serverless Image Processing)" và ảnh chụp trao đổi nhóm ngày 13/11/2026 tôi cung cấp.

**Phạm vi của tôi chỉ là FRONTEND REACT.** Không viết hoặc chỉnh sửa backend, Firebase Rules, Cloud Functions, IaC, CI/CD hay code của thành viên khác. Giai đoạn đầu CHỈ PHÂN TÍCH, KHÔNG SỬA CODE.

Bối cảnh: PDF gốc dùng AWS S3/Lambda/SQS/DynamoDB, trạng thái PENDING -> PROCESSING -> DONE/FAILED. Nhóm đang thảo luận Firebase Auth/Storage/Firestore/Hosting và có phương án xử lý resize/compress/WebP bằng Canvas hoặc browser-image-compression trên client để tránh phí Cloud Functions. Đây chưa chắc là quyết định cuối cùng; xác minh repo/contract và liệt kê điểm cần nhóm xác nhận. Không đánh đồng xử lý client với serverless trigger.

Hãy trả lời lần lượt:
1. Sơ đồ cây frontend, framework, dependency, lệnh chạy, các màn hình/components/hooks/services hiện có; dẫn đường dẫn file và đoạn code minh chứng. Phân loại: ĐÃ CÓ / THIẾU / CHƯA XÁC MINH.
2. Đánh giá UC01 (upload, validate JPG/PNG/WebP <=10MB, preview, progress), UC03 (status/onSnapshot nếu Firebase), UC04 (gallery, limit <=20, cursor), UC05 (download/delete), login Google/UID, UC07 UI admin nếu có. Với từng UC: code hiện có, lỗi, độ ưu tiên, tiêu chí test.
3. Kiểm tra frontend có gọi API/Firebase đúng contract/schema không; tên field ownerId/uid, createdAt, storage key, URLs, pagination, security assumptions. Không tự suy diễn contract. Nếu chưa có backend, đề xuất adapter/mock tách biệt và chỉ rõ mock.
4. Phân tích lựa chọn A: cloud-trigger xử lý ảnh; lựa chọn B: xử lý ngay trên client. So sánh UX, progress, status, retry, tính trung thực với mục tiêu môn học, chi phí và tác động frontend. Đề xuất những quyết định cần hỏi nhóm.
5. Rà soát bug và rủi ro: useEffect/onSnapshot unsubscribe, memory leak URL.createObjectURL, stale state, race conditions, file hỏng, upload dở dang, MIME spoofing, giới hạn ảnh, permissions, responsive, accessibility, empty/loading/error states.
6. Đề xuất kiến trúc frontend theo cấu trúc repo hiện có; KHÔNG áp đặt framework hay chuyển JS sang TS nếu không cần. Liệt kê file mới/sửa dự kiến, dependencies và cách tích hợp không xung đột công việc nhóm.
7. Lập kế hoạch theo thứ tự ưu tiên để tôi có thể demo: (a) login, (b) upload, (c) progress/status, (d) gallery, (e) download/delete, (f) hoàn thiện UX. Với mỗi bước nêu điều kiện đầu vào, công việc, kết quả, test và blocker.
8. Viết checklist test thủ công và các lệnh lint/build/test có thật trong package.json; không khẳng định test đã chạy nếu chưa chạy.
9. Cuối cùng, hỏi tôi tối đa 5 câu cần chốt với nhóm, và chờ tôi cho phép trước khi sửa code.

Định dạng: báo cáo tiếng Việt, bảng ưu tiên P0/P1/P2, đường dẫn file chính xác, phân biệt FACT / INFERENCE / PROPOSAL, không bịa file, API hay kết quả kiểm thử. Tuyệt đối không thay đổi file ở lượt phân tích đầu tiên.
