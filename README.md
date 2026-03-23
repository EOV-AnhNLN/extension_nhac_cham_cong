# Tiện ích Nhắc Nhở Chấm Công FastWork ⏰

Đây là một Extension (tiện ích mở rộng) dành cho Google Chrome và các trình duyệt sử dụng lõi Chromium (Edge, Brave, Cốc Cốc, ...), với mục đích nhắc nhở người dùng thực hiện chấm công trên hệ thống FastWork.

## 🌟 Chức năng nổi bật

- 🔄 **Đồng bộ tự động**: Tự động kết nối và lấy dữ liệu trạng thái chấm công trực tiếp từ trang web FastWork.
- 🌞 **Nhắc nhở buổi trưa**: Mặc định cảnh báo lúc **12:00** để nhắc bạn chấm công ra ăn trưa.
- 🌙 **Nhắc nhở buổi chiều**: Mặc định cảnh báo lúc **17:00** để nhắc bạn chấm công trước khi ra về.
- 🔊 **Cảnh báo âm thanh & hiển thị**: Hiển thị popup ngay trên màn hình và phát ra âm thanh (tiếng bíp) để đảm bảo bạn không bỏ lỡ.
- 🔁 **Nhắc nhở lặp lại**: Nếu bạn lỡ "Bỏ qua", hệ thống sẽ tự động kiểm tra lại và nhắc nhở sau 1 phút nếu bạn chưa thực sự chấm công.
- ⚙️ **Tùy chỉnh linh hoạt**: Có thể thay đổi thời gian nhắc nhở hoặc bật/tắt nhắc cho từng buổi thông qua giao diện popup của tiện ích.
- 📊 **Theo dõi trạng thái**: Hiển thị trạng thái chấm công thực tế của ngày hôm nay (giờ vào/ra ca sáng và chiều) trực tiếp trên trình duyệt mà không cần mở FastWork.

## 🚀 Hướng dẫn cài đặt

1. Tải về hoặc `clone` mã nguồn của tiện ích này về máy tính của bạn và giải nén (nếu tải dạng file `.zip`).
2. Mở trình duyệt Chrome (hoặc Edge, Brave, ...).
3. Truy cập vào trang quản lý tiện ích:
   - Chrome: Gõ `chrome://extensions/` vào thanh địa chỉ.
   - Edge: Gõ `edge://extensions/`.
4. Bật chế độ **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải màn hình.
5. Nhấn vào nút **Load unpacked** (Tải tiện ích đã giải nén).
6. Chọn thư mục chứa mã nguồn của tiện ích mà bạn vừa tải về (thư mục chứa file `manifest.json`).
7. Biểu tượng tiện ích sẽ hiển thị trên thanh công cụ của trình duyệt. Bạn có thể ghim (Pin) nó lại để dễ dàng theo dõi.

## 📖 Hướng dẫn sử dụng

### Xem trạng thái & Đồng bộ dữ liệu

1. Nhấp vào biểu tượng của tiện ích trên thanh công cụ để mở giao diện quản lý.
2. Tại phần **Trạng thái hôm nay**, tiện ích sẽ hiển thị thời gian chấm công của bạn trong ngày.
3. Nếu mở lần đầu trong ngày, dữ liệu có thể chưa được tải (sẽ hiển thị "Mở FastWork để đồng bộ"). 
4. Bạn có thể nhấn nút **Mở FastWork** để trình duyệt mở thẻ mới vào trang chấm công. Dữ liệu sẽ lập tức được đọc về!
5. Hoặc nhấn nút 🔄 (Làm mới) để thử đồng bộ lại.

### Cài đặt nhắc nhở

1. Trên giao diện, bạn sẽ thấy 2 khối nhắc nhở: **Buổi Trưa** và **Buổi Chiều**.
2. **Bật/Tắt nhắc nhở**: Kéo thanh gạt (Công tắc) bên cạnh tiêu đề để kích hoạt hoặc hủy nhắc nhở theo từng buổi.
3. **Thay đổi thời gian**: Nhấp vào ô thời gian (mặc định là `12:00` và `17:00`) để điều chỉnh theo đúng lịch làm việc của công ty bạn.
4. Nhấn nút **Lưu Cài Đặt** 💾 để hệ thống ghi nhận lịch nhắc nhở mới.

### Kiểm tra thử nhắc nhở (Test)

Bạn có thể nhấn vào nút **Test Thông Báo** 🔔 ở mỗi buổi. Một cửa sổ popup cảnh báo sẽ hiện lên ở góc màn hình kèm theo âm thanh để bạn hình dung được cách mà hệ thống thông báo.

*Lưu ý: Bạn có thể tắt tiếng bíp của cửa sổ nhắc nhở bằng cách nhấn "Đã hiểu, đóng lại" hoặc nhấn "Mở FastWork" để xác nhận đi chuyển trang.*

## 🔒 Thông tin quyền sử dụng (Permissions)
Tiện ích này yêu cầu quyền truy cập vào `app.fastwork.vn` để thu thập thời gian thực trạng thái báo danh của cá nhân, đảm bảo không thu thập thông tin cá nhân ở những trang web khác.

> 💡 **Lưu ý Quan Trọng**: Tiện ích có bộ lọc thông minh; khi đến giờ thiết lập báo thức, tiện ích sẽ ngay lập tức đối chiếu dữ liệu hiện tại với thời điểm đó. Nếu phát hiện bạn đã thực hiện chấm công FastWork thành công, hệ thống nhắc nhở sẽ không làm phiền bạn!
