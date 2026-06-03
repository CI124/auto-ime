using System;
using System.Runtime.InteropServices;

/// <summary>
/// TSF Helper - 检测 TSF 输入法状态
/// 编译: csc /target:library /out:tsf-helper.dll tsf-helper.cs
/// 通过 koffi FFI 从 Node.js 调用
/// </summary>
public class TSFHelper
{
    // COM 类和接口 GUID
    private static readonly Guid CLSID_TF_ThreadMgr = new Guid("529a9e6b-6587-4f23-ab9e-9c7d683e3c50");
    private static readonly Guid IID_ITfThreadMgr = new Guid("aa80e801-2021-11d2-93e0-0060b067b86e");
    private static readonly Guid IID_ITfThreadMgrEx = new Guid("3e90ade3-7594-4cb0-bb58-69628f5f44af");

    [ComImport, Guid("aa80e801-2021-11d2-93e0-0060b067b86e")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITfThreadMgr
    {
        // Activate/Deactivate + GetFocus/SetFocus 等
        // 我们只需要 Activate 和 Deactivate
    }

    [ComImport, Guid("3e90ade3-7594-4cb0-bb58-69628f5f44af")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITfThreadMgrEx
    {
        // ActivateEx 用于带标志激活
        int ActivateEx(out uint clientId, uint flags);
        int Deactivate();
    }

    [ComImport, Guid("6aa93b02-33c2-4e86-8e5f-2e3d47e0e448")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITfInputProcessorProfiles
    {
        int Register();
        int Unregister();
        int AddLanguageProfile();
        int RemoveLanguageProfile();
        int EnumInputProcessorInfo(out IntPtr ppEnum);
        int GetDefaultLanguageProfile(uint langid, ref Guid clsid, out Guid profileGuid);
        int SetDefaultLanguageProfile(uint langid, ref Guid clsid, ref Guid profileGuid);
        int ActivateLanguageProfile(ref Guid clsid, uint langid, ref Guid profileGuid);
        int GetActiveLanguageProfile(ref Guid clsid, out uint plangid, out Guid profileGuid);
        int GetLanguageProfileDescription(ref Guid clsid, uint langid, ref Guid profileGuid, out IntPtr pbstrProfile);
        int GetCurrentLanguage(out uint plangid);
    }

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(
        ref Guid clsid,
        IntPtr pUnkOuter,
        uint dwClsContext,
        ref Guid iid,
        out IntPtr ppv);

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    private const uint CLSCTX_INPROC_SERVER = 0x1;
    private const uint COINIT_APARTMENTTHREADED = 0x2;

    /// <summary>
    /// 检测当前是否有 TSF 输入法管理器激活
    /// </summary>
    public static bool IsTSFEnabled()
    {
        try
        {
            CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED);
            Guid iid = IID_ITfThreadMgr;
            Guid clsid = CLSID_TF_ThreadMgr;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, CLSCTX_INPROC_SERVER, ref iid, out IntPtr pUnk);
            if (hr != 0 || pUnk == IntPtr.Zero) return false;

            // 尝试 QueryInterface for ITfThreadMgrEx
            Guid iidEx = IID_ITfThreadMgrEx;
            hr = Marshal.QueryInterface(pUnk, ref iidEx, out IntPtr pEx);
            Marshal.Release(pUnk);

            if (hr != 0 || pEx == IntPtr.Zero) return false;
            Marshal.Release(pEx);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
