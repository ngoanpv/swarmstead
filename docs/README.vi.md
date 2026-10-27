# Swarmstead: tóm tắt tiếng Việt

[English README](../README.md)

**Swarmstead** biến các phiên Claude Code (và Codex, bản beta) thành một ngôi làng pixel sống động:

- Mỗi agent là một nhân vật. Subagent bước ra từ cổng phép, làm việc, rồi mang cuộn giấy về báo cáo cho agent chính.
- Test fail thì quái vật xuất hiện. Token tiêu đến đâu, đồng xu bay vào rương đến đó.
- Hệ thống tự phát hiện: lặp vòng, kẹt chờ duyệt quyền (nhất là subagent chạy nền), context sắp đầy, hai agent sửa cùng một file, tốc độ đốt tiền cao.
- **Tiến hoá nhân vật**: XP chỉ đến từ lượt làm việc đã hoàn thành, tính theo khối lượng × chất lượng × tiết kiệm × cache. Thói quen làm việc quyết định loài: đọc → Cú, viết → Cáo, chạy lệnh → Robot, web → Thỏ, giao việc → Mèo.
- Lặp vòng làm nhân vật bị "glitch". Mười lượt sạch liên tiếp sẽ thành **SHINY**.
- Khi subagent xong việc, nó đi về bàn agent điều phối, xếp hàng và trao cuộn giấy. Màu cuộn giấy cho biết kết quả: xanh là sạch, vàng là trục trặc, đỏ là thất bại, tím là có thể mất do nén context. Khi đủ báo cáo, các cuộn giấy gộp thành một cuốn sách phát sáng.
- Workflow lớn (hàng chục đến hàng trăm agent) chuyển sang **Đấu trường**: mỗi giai đoạn một bệ, agent cùng giai đoạn gộp thành đội ×N, và tab **Dòng thời gian** chỉ ra agent chậm bất thường.

- **Duyệt quyền từ làng hoặc điện thoại** (`install claude --gate`, cấu hình `notify.ntfy`): subagent chạy nền không còn bị kẹt vì không ai thấy hộp thoại.
- **Dự báo**: workflow này sẽ tốn bao nhiêu (so với các lần chạy trước), có chạm trần khối 5 giờ hay hạn mức Codex trước khi reset không, kèm "phanh ngân sách" tuỳ chọn.
- **Bắt lời khai "tests pass"** khi chưa có lần chạy test nào thành công sau lần sửa cuối.
- **Dự báo xung đột merge** giữa các git worktree.
- **Chi phí trên mỗi commit / PR** (tab Ledger, `install git`).
- **Tua lại một ngày** và **post-mortem**: tiền đi đâu, bao nhiêu là lãng phí, chép thành Markdown để chia sẻ.

Cài đặt: chạy `claude plugin marketplace add ngoanpv/swarmstead` rồi `claude plugin install swarmstead@swarmstead`, mở một session Claude Code mới (làng tự khởi động và địa chỉ hiện ở đầu session), rồi gõ `/village` hoặc mở http://127.0.0.1:4317/web/. Kiểm tra bằng `npx swarmstead doctor`, cập nhật bằng `claude plugin update swarmstead@swarmstead`. Chỉ muốn xem thử: `npx swarmstead start --open` rồi thêm `?demo&lang=vi`, hoặc mở [bản demo trực tuyến](https://ngoanpv.github.io/swarmstead/).
