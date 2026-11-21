using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    /// <summary>
    /// Loads with Revit. Opens a private local connection (127.0.0.1 only) that the
    /// Ollic Sketch hub uses to send commands. Commands run on Revit's own thread
    /// through an ExternalEvent, each inside its own named transaction, so the
    /// architect can undo any change with Ctrl+Z in Revit.
    /// </summary>
    public class App : IExternalApplication
    {
        internal static CommandQueue Queue;
        internal static ExternalEvent Event;
        private static CommandServer _server;

        public Result OnStartup(UIControlledApplication application)
        {
            try
            {
                Queue = new CommandQueue();
                Event = ExternalEvent.Create(Queue);
                _server = new CommandServer(Queue, Event, application.ControlledApplication.VersionNumber);
                _server.Start();
            }
            catch (Exception ex)
            {
                TaskDialog.Show("Ollic Sketch", "Ollic Sketch could not start its connection: " + ex.Message);
            }
            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            _server?.Stop();
            Event?.Dispose();
            return Result.Succeeded;
        }
    }

    internal class Pending
    {
        public JObject Request;
        public TaskCompletionSource<JObject> Done = new TaskCompletionSource<JObject>(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    /// <summary>Runs queued commands on Revit's main thread.</summary>
    public class CommandQueue : IExternalEventHandler
    {
        private readonly ConcurrentQueue<Pending> _queue = new ConcurrentQueue<Pending>();

        internal void Add(Pending p) => _queue.Enqueue(p);

        public void Execute(UIApplication app)
        {
            while (_queue.TryDequeue(out var p))
            {
                try
                {
                    var result = Dispatcher.Run(app, p.Request);
                    p.Done.TrySetResult(new JObject { ["ok"] = true, ["result"] = result });
                }
                catch (Exception ex)
                {
                    p.Done.TrySetResult(new JObject { ["ok"] = false, ["error"] = ex.Message });
                }
            }
        }

        public string GetName() => "Ollic Sketch commands";
    }

    /// <summary>
    /// Line-based JSON over TCP on 127.0.0.1. One request line in, one response line out.
    /// Request: {"tool":"create_walls","args":{...}}
    /// Response: {"ok":true,"result":...} or {"ok":false,"error":"..."}
    /// Each running Revit writes its port to %LOCALAPPDATA%\OllicSketch\instances\revit-PID.json.
    /// </summary>
    internal class CommandServer
    {
        private const int FirstPort = 48884;
        private readonly CommandQueue _queue;
        private readonly ExternalEvent _event;
        private readonly string _revitVersion;
        private TcpListener _listener;
        private CancellationTokenSource _cts;
        private string _instanceFile;

        public CommandServer(CommandQueue queue, ExternalEvent ev, string revitVersion)
        {
            _queue = queue; _event = ev; _revitVersion = revitVersion;
        }

        public void Start()
        {
            int port = 0;
            for (int p = FirstPort; p < FirstPort + 20; p++)
            {
                try { _listener = new TcpListener(IPAddress.Loopback, p); _listener.Start(); port = p; break; }
                catch (SocketException) { _listener = null; }
            }
            if (_listener == null) throw new Exception("no free local port between 48884 and 48903");

            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OllicSketch", "instances");
            Directory.CreateDirectory(dir);
            int pid = Process.GetCurrentProcess().Id;
            _instanceFile = Path.Combine(dir, "revit-" + pid + ".json");
            File.WriteAllText(_instanceFile, new JObject
            {
                ["app"] = "revit",
                ["version"] = _revitVersion,
                ["port"] = port,
                ["pid"] = pid,
                ["started"] = DateTime.UtcNow.ToString("o")
            }.ToString());

            _cts = new CancellationTokenSource();
            Task.Run(() => AcceptLoop(_cts.Token));
        }

        public void Stop()
        {
            try { _cts?.Cancel(); _listener?.Stop(); } catch { }
            try { if (_instanceFile != null && File.Exists(_instanceFile)) File.Delete(_instanceFile); } catch { }
        }

        private async Task AcceptLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(); }
                catch { if (ct.IsCancellationRequested) return; continue; }
                _ = Task.Run(() => Handle(client, ct));
            }
        }

        private async Task Handle(TcpClient client, CancellationToken ct)
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" })
            {
                string line;
                while (!ct.IsCancellationRequested && (line = await reader.ReadLineAsync()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    JObject response;
                    try
                    {
                        var req = JObject.Parse(line);
                        if ((string)req["tool"] == "ping")
                        {
                            response = new JObject { ["ok"] = true, ["result"] = new JObject { ["app"] = "revit", ["version"] = _revitVersion } };
                        }
                        else
                        {
                            var p = new Pending { Request = req };
                            _queue.Add(p);
                            var raised = _event.Raise();
                            var finished = await Task.WhenAny(p.Done.Task, Task.Delay(TimeSpan.FromMinutes(5), ct));
                            response = finished == p.Done.Task
                                ? p.Done.Task.Result
                                : new JObject { ["ok"] = false, ["error"] = "Revit did not respond within 5 minutes. Close any open dialog in Revit and try again." };
                            if (raised == ExternalEventRequest.Denied || raised == ExternalEventRequest.TimedOut)
                                response["note"] = "Revit was busy; the command ran when it became free.";
                        }
                    }
                    catch (Exception ex)
                    {
                        response = new JObject { ["ok"] = false, ["error"] = ex.Message };
                    }
                    await writer.WriteLineAsync(response.ToString(Formatting.None));
                }
            }
        }
    }
}
