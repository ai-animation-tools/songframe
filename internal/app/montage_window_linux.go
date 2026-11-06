//go:build linux && cgo && !gtk3 && !android && !server

package app

/*
#cgo linux pkg-config: gtk4 webkitgtk-6.0
#include <dlfcn.h>
#include <gtk/gtk.h>
#include <webkit/webkit.h>
#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#endif

// sf_montage_decide_policy разрешает документу окна плеера звук без жеста пользователя.
// Политика сайта WebKitGTK по умолчанию — WEBKIT_AUTOPLAY_ALLOW_WITHOUT_SOUND, у Wails нет
// опции для неё, а задать её можно только решением навигации (webkit_policy_decision_use_with_policies).
static gboolean sf_montage_decide_policy(WebKitWebView *view, WebKitPolicyDecision *decision, WebKitPolicyDecisionType type, gpointer data) {
	if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) return FALSE;
	WebKitWebsitePolicies *policies = webkit_website_policies_new_with_policies("autoplay", WEBKIT_AUTOPLAY_ALLOW, NULL);
	webkit_policy_decision_use_with_policies(decision, policies);
	g_object_unref(policies);
	return TRUE;
}

// sf_find_webview ищет WebKitWebView среди потомков окна Wails (окно → контейнер → webview).
static GtkWidget *sf_find_webview(GtkWidget *widget) {
	if (WEBKIT_IS_WEB_VIEW(widget)) return widget;
	for (GtkWidget *child = gtk_widget_get_first_child(widget); child != NULL; child = gtk_widget_get_next_sibling(child)) {
		GtkWidget *found = sf_find_webview(child);
		if (found != NULL) return found;
	}
	return NULL;
}

typedef int (*sf_XMoveWindow)(Display *, Window, int, int);

// sf_montage_show показывает скрытое окно плеера: в X11 сначала ставит его в (x, y) — до показа,
// потому что перемещение показанного окна в Wails/GTK4 сбрасывает его размер к минимальному, —
// затем подключает политику автозапуска и заново открывает текущий адрес (первая навигация
// к этому моменту уже решена без политики, а reload решения навигации не проходит).
// XMoveWindow берётся через dlsym, как в Wails: libX11 не становится зависимостью бинарника.
// Возвращает 0, если webview не найден (окно всё равно показывается).
static int sf_montage_show(void *window, int move, int x, int y) {
	if (window == NULL) return 0;
	GtkWidget *widget = GTK_WIDGET(window);
#ifdef GDK_WINDOWING_X11
	if (move) {
		gtk_widget_realize(widget);
		GtkNative *native = gtk_widget_get_native(widget);
		GdkSurface *surface = native != NULL ? gtk_native_get_surface(native) : NULL;
		sf_XMoveWindow move_window = (sf_XMoveWindow)dlsym(RTLD_DEFAULT, "XMoveWindow");
		if (surface != NULL && GDK_IS_X11_SURFACE(surface) && move_window != NULL)
			move_window(gdk_x11_display_get_xdisplay(gdk_surface_get_display(surface)), gdk_x11_surface_get_xid(surface), x, y);
	}
#endif
	gtk_window_present(GTK_WINDOW(window));
	GtkWidget *view = sf_find_webview(widget);
	if (view == NULL) return 0;
	g_signal_connect(view, "decide-policy", G_CALLBACK(sf_montage_decide_policy), NULL);
	gchar *uri = g_strdup(webkit_web_view_get_uri(WEBKIT_WEB_VIEW(view)));
	if (uri == NULL) return 0;
	webkit_web_view_load_uri(WEBKIT_WEB_VIEW(view), uri);
	g_free(uri);
	return 1;
}

// sf_montage_release_idle снимает ссылки на закрытое окно, уже вне gtk_window_destroy. Обычно их
// две: своя и лишняя ссылка Wails. Единица значит, что Wails свою уже отпускает, и трогать её нельзя.
static gboolean sf_montage_release_idle(gpointer data) {
	GObject *window = G_OBJECT(data);
	if (window->ref_count == 2) g_object_unref(window);
	g_object_unref(window);
	return G_SOURCE_REMOVE;
}

static void sf_montage_unrealized(GtkWidget *widget, gpointer data) {
	g_signal_handlers_disconnect_by_func(widget, (gpointer)sf_montage_unrealized, data);
	g_idle_add(sf_montage_release_idle, widget);
}

// sf_montage_release_on_close готовит освобождение окна: срабатывает из gtk_window_destroy, когда
// Wails его вызовет. Окно, которое ни разу не показывалось, не реализовано и остаётся как есть.
static void sf_montage_release_on_close(void *window) {
	if (window == NULL || !gtk_widget_get_realized(GTK_WIDGET(window))) return;
	g_object_ref(window);
	g_signal_connect(window, "unrealize", G_CALLBACK(sf_montage_unrealized), NULL);
}
*/
import "C"

import (
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// newMontageNativeWindow создаёт окно плеера в сборке GTK4 с тремя поправками к Wails 3.
//
// Воспроизведение без жеста: аналог autoplayPolicy 'no-user-gesture-required' окна Electron.
// Плеер запускают кнопкой или клавишей в основном окне, жеста в самом окне нет, и WebKitGTK
// отклоняет audio.play() (NotAllowedError) — это показала нативная проверка «Окно плеера монтажа…».
//
// Размер и положение: Wails ставит показанное окно (центр или X/Y) перемещением X11, после
// которого GTK4 сжимает окно до минимального размера, — окно плеера открывалось бы 480×270
// вместо 820×540 или сохранённого размера. Поэтому окно создаётся скрытым и показывается здесь,
// при первом начале загрузки его страницы (раньше нативного webview нет), уже на своём месте.
// Без сохранённого положения место выбирает оконный менеджер, как у окна Electron без x/y.
// Если событие загрузки не придёт, окно показывается по таймеру — скрытым оно не останется.
//
// Закрытие: Wails 3 в сборке GTK4 берёт на окно лишнюю ссылку (g_object_ref_sink в windowNew) и не
// отпускает её, поэтому gtk_window_destroy только прячет окно, а webview со страницей живёт
// дальше. Для плеера это слышно: <audio> играет без окна, а часы на requestAnimationFrame в
// скрытой странице стоят, поэтому звук уходит за границы участка и накладывается на встроенный
// плеер. Хук освобождает окно сразу после destroy, вместе с ним уходят страница и её медиа.
func newMontageNativeWindow(desktop *application.App, options application.WebviewWindowOptions) *application.WebviewWindow {
	native := options
	native.Hidden = true
	window := desktop.Window.NewWithOptions(native)
	move, x, y := 0, 0, 0
	if options.InitialPosition == application.WindowXY && options.Screen != nil {
		move, x, y = 1, options.Screen.WorkArea.X+options.X, options.Screen.WorkArea.Y+options.Y
	}
	var once sync.Once
	show := func() {
		once.Do(func() {
			application.InvokeSync(func() {
				if C.sf_montage_show(window.NativeWindow(), C.int(move), C.int(x), C.int(y)) == 0 {
					log.Print("окно плеера монтажа: не найден WebKitWebView, воспроизведение без жеста недоступно")
				}
			})
		})
	}
	// Окно запускается в отдельной горутине Wails: если начало загрузки придёт раньше хука,
	// показ выполнит конец той же загрузки.
	window.RegisterHook(events.Linux.WindowLoadStarted, func(*application.WindowEvent) { show() })
	var release sync.Once
	window.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
		release.Do(func() { application.InvokeSync(func() { C.sf_montage_release_on_close(window.NativeWindow()) }) })
	})
	window.RegisterHook(events.Linux.WindowLoadFinished, func(*application.WindowEvent) { show() })
	time.AfterFunc(3*time.Second, func() {
		if window.NativeWindow() != nil {
			show()
		}
	})
	return window
}
